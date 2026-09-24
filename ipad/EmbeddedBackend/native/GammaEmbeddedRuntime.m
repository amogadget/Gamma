#import "GammaEmbeddedRuntime.h"
#if __has_include(<Python/Python.h>)
#import <Python/Python.h>
#else
#include <Python.h>
#endif

#if GAMMA_EMBEDDED_PDF
extern PyObject *PyInit__gamma_ios_pdf(void);
#endif

static NSError *HostError(NSInteger code, NSString *message) {
    return [NSError errorWithDomain:@"GammaEmbeddedRuntime" code:code
                          userInfo:@{NSLocalizedDescriptionKey: message}];
}

@interface GammaEmbeddedRuntime () {
    NSCondition *_condition;
    NSThread *_worker;
    NSURL *_dataRoot;
    NSURL *_bundleRoot;
    BOOL _requested, _busy, _stopRequested, _initialized, _poisoned;
    NSUInteger _generation;
    PyObject *_stopEvent; // Access only with BOTH GIL and condition lock.
    void (^_ready)(NSData *, NSError *);
    NSMutableArray<void (^)(NSError *)> *_stopWaiters;
}
- (instancetype)initPrivate;
- (void)publish:(NSData *)data generation:(NSUInteger)generation;
- (void)workerMain;
@end

// Called under the GIL. No exception strings or tracebacks cross the boundary.
static PyObject *HostReady(PyObject *generation, PyObject *result) {
    PyObject *dc = PyImport_ImportModule("dataclasses");
    PyObject *json = PyImport_ImportModule("json");
    PyObject *dict = dc ? PyObject_CallMethod(dc, "asdict", "O", result) : NULL;
    PyObject *text = (dict && json) ? PyObject_CallMethod(json, "dumps", "O", dict) : NULL;
    Py_ssize_t length = 0;
    const char *bytes = text ? PyUnicode_AsUTF8AndSize(text, &length) : NULL;
    if (bytes && length > 0 && length <= 65536) {
        NSData *data = [NSData dataWithBytes:bytes length:(NSUInteger)length];
        [[GammaEmbeddedRuntime sharedRuntime] publish:data generation:PyLong_AsUnsignedLong(generation)];
    } else if (!PyErr_Occurred()) {
        PyErr_SetString(PyExc_ValueError, "Invalid native bootstrap");
    }
    Py_XDECREF(text); Py_XDECREF(dict); Py_XDECREF(json); Py_XDECREF(dc);
    if (PyErr_Occurred()) return NULL;
    Py_RETURN_NONE;
}
static PyMethodDef ReadyMethod = {"ready", HostReady, METH_O, NULL};
static struct PyModuleDef HostModule = {PyModuleDef_HEAD_INIT, "_gamma_ios_host", NULL, -1, NULL};
static PyObject *PyInit__gamma_ios_host(void) { return PyModule_Create(&HostModule); }

@implementation GammaEmbeddedRuntime
+ (instancetype)sharedRuntime {
    static GammaEmbeddedRuntime *runtime;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ runtime = [[self alloc] initPrivate]; });
    return runtime;
}
- (instancetype)initPrivate {
    if ((self = [super init])) {
        _condition = [NSCondition new];
        _stopWaiters = [NSMutableArray new];
        _bundleRoot = [NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"EmbeddedGamma" isDirectory:YES];
    }
    return self;
}
- (void)startWithDataRoot:(NSURL *)dataRoot completion:(void (^)(NSData *, NSError *))completion {
    NSAssert(NSThread.isMainThread, @"Main-thread API");
    NSURL *root = dataRoot.URLByStandardizingPath.URLByResolvingSymlinksInPath;
    NSURL *support = [[NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory
                                                         inDomains:NSUserDomainMask] firstObject].URLByResolvingSymlinksInPath;
    if (!dataRoot.isFileURL || ![root.path hasPrefix:[support.path stringByAppendingString:@"/"]]) {
        completion(nil, HostError(1, @"Embedded data must be inside Application Support.")); return;
    }
    [_condition lock];
    if (_busy || _poisoned || (_dataRoot && ![_dataRoot isEqual:root])) {
        [_condition unlock];
        completion(nil, HostError(2, @"Runtime unavailable; stop first and reuse the same data directory.")); return;
    }
    _dataRoot = root; _busy = YES; _requested = YES; _stopRequested = NO;
    _generation++; _ready = [completion copy];
    if (!_worker) {
        _worker = [[NSThread alloc] initWithTarget:self selector:@selector(workerMain) object:nil];
        _worker.name = @"Gamma CPython owner";
        [_worker start];
    }
    [_condition signal]; [_condition unlock];
}
- (void)publish:(NSData *)data generation:(NSUInteger)generation {
    dispatch_async(dispatch_get_main_queue(), ^{
        [self->_condition lock];
        void (^ready)(NSData *, NSError *) = nil;
        if (generation == self->_generation && !self->_stopRequested) {
            ready = self->_ready; self->_ready = nil;
        }
        [self->_condition unlock];
        if (ready) ready(data, nil);
    });
}
- (void)stopWithCompletion:(void (^)(NSError *))completion {
    NSAssert(NSThread.isMainThread, @"Main-thread API");
    [_condition lock];
    if (!_busy) { [_condition unlock]; completion(nil); return; }
    _stopRequested = YES;
    NSUInteger generation = _generation;
    void (^ready)(NSData *, NSError *) = _ready; _ready = nil;
    [_stopWaiters addObject:[completion copy]];
    BOOL initialized = _initialized;
    [_condition unlock];
    if (ready) ready(nil, HostError(3, @"Runtime start cancelled."));
    // Never acquire the GIL on main (including while Py_InitializeFromConfig runs).
    if (initialized) dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        PyGILState_STATE gil = PyGILState_Ensure();
        [self->_condition lock];
        PyObject *event = generation == self->_generation ? self->_stopEvent : NULL;
        Py_XINCREF(event);
        [self->_condition unlock];
        if (event) {
            PyObject *answer = PyObject_CallMethod(event, "set", NULL);
            Py_XDECREF(answer); Py_DECREF(event); PyErr_Clear();
        }
        PyGILState_Release(gil);
    });
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 12 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        [self->_condition lock];
        NSArray *waiters = @[];
        if (self->_busy && generation == self->_generation) {
            waiters = [self->_stopWaiters copy]; [self->_stopWaiters removeAllObjects];
        }
        [self->_condition unlock];
        for (void (^waiter)(NSError *) in waiters)
            waiter(HostError(4, @"Shutdown is still pending; the process-owned interpreter remains alive."));
    });
}
- (BOOL)initializePython {
    if (Py_IsInitialized()) return NO; // Never attach to an unrelated interpreter.
    if (PyImport_AppendInittab("_gamma_ios_host", PyInit__gamma_ios_host) != 0) return NO;
#if GAMMA_EMBEDDED_PDF
    if (PyImport_AppendInittab("_gamma_ios_pdf", PyInit__gamma_ios_pdf) != 0) return NO;
#endif
    PyConfig config; PyConfig_InitIsolatedConfig(&config);
    config.install_signal_handlers = 0;
    config.write_bytecode = 0;
    config.site_import = 0;
    config.module_search_paths_set = 1;
    NSArray<NSString *> *paths = @[@"python/lib/python3.13", @"python/lib/python3.13/lib-dynload", @"app", @"app_packages"];
    PyStatus status = PyConfig_SetBytesString(&config, &config.home,
        [_bundleRoot URLByAppendingPathComponent:@"python"].path.fileSystemRepresentation);
    if (PyStatus_Exception(status)) { PyConfig_Clear(&config); return NO; }
    for (NSString *relative in paths) {
        NSString *path = [_bundleRoot URLByAppendingPathComponent:relative].path;
        wchar_t *wide = Py_DecodeLocale(path.fileSystemRepresentation, NULL);
        if (!wide) { PyConfig_Clear(&config); return NO; }
        status = PyWideStringList_Append(&config.module_search_paths, wide);
        PyMem_RawFree(wide);
        if (PyStatus_Exception(status)) { PyConfig_Clear(&config); return NO; }
    }
    status = Py_InitializeFromConfig(&config);
    PyConfig_Clear(&config);
    if (PyStatus_Exception(status)) return NO;
    // Fail-closed sanitization: arbitrary Python output may contain user secrets.
    // Keep only a bounded write count, never raw content, including partial lines.
    const char *sink =
        "import sys\n"
        "class _GammaPrivateOutput:\n"
        "    encoding = 'utf-8'\n"
        "    errors = 'replace'\n"
        "    writes = 0\n"
        "    def write(self, text):\n"
        "        self.writes = min(self.writes + 1, 1024)\n"
        "        return len(text)\n"
        "    def flush(self): pass\n"
        "    def isatty(self): return False\n"
        "sys.stdout = sys.stderr = _GammaPrivateOutput()\n"
        "sys.__stdout__ = sys.__stderr__ = sys.stdout\n"
        "import os, certifi\n"
        "os.environ['SSL_CERT_FILE'] = certifi.where()\n";
    if (PyRun_SimpleString(sink) != 0) { PyErr_Clear(); return NO; }
    return YES;
}
- (BOOL)serveGeneration:(NSUInteger)generation {
    PyObject *module = PyImport_ImportModule("gamma_ios_runtime");
    PyObject *pathlib = PyImport_ImportModule("pathlib");
    PyObject *threading = PyImport_ImportModule("threading");
    PyObject *data = pathlib ? PyObject_CallMethod(pathlib, "Path", "s", _dataRoot.path.fileSystemRepresentation) : NULL;
    PyObject *frontend = pathlib ? PyObject_CallMethod(pathlib, "Path", "s", [_bundleRoot URLByAppendingPathComponent:@"frontend"].path.fileSystemRepresentation) : NULL;
    PyObject *config = (module && data && frontend) ? PyObject_CallMethod(module, "RuntimeConfig", "OO", data, frontend) : NULL;
    PyObject *event = threading ? PyObject_CallMethod(threading, "Event", NULL) : NULL;
    PyObject *number = PyLong_FromUnsignedLong(generation);
    PyObject *callback = number ? PyCFunction_NewEx(&ReadyMethod, number, NULL) : NULL;
    [_condition lock];
    _stopEvent = event; // Local ref lives until detached below.
    BOOL cancelled = _stopRequested;
    [_condition unlock];
    if (cancelled && event) {
        PyObject *answer = PyObject_CallMethod(event, "set", NULL); Py_XDECREF(answer);
    }
    PyObject *answer = (config && event && callback && !PyErr_Occurred()) ?
        PyObject_CallMethod(module, "serve", "OOO", config, callback, event) : NULL;
    BOOL success = answer != NULL;
    // Deliberately discard exception value: even str(exception) may contain tokens.
    PyErr_Clear();
    [_condition lock]; _stopEvent = NULL; [_condition unlock];
    Py_XDECREF(answer); Py_XDECREF(callback); Py_XDECREF(number); Py_XDECREF(event);
    Py_XDECREF(config); Py_XDECREF(frontend); Py_XDECREF(data);
    Py_XDECREF(threading); Py_XDECREF(pathlib); Py_XDECREF(module);
    return success;
}
- (void)workerMain {
    PyThreadState *saved = NULL;
    for (;;) { @autoreleasepool {
        [_condition lock];
        while (!_requested) [_condition wait];
        _requested = NO; NSUInteger generation = _generation;
        [_condition unlock];
        BOOL initialized = _initialized;
        if (!initialized) {
            initialized = [self initializePython];
            [_condition lock]; _initialized = initialized; _poisoned = !initialized; [_condition unlock];
        } else { PyEval_RestoreThread(saved); saved = NULL; }
        BOOL success = initialized && [self serveGeneration:generation];
        if (initialized) saved = PyEval_SaveThread();
        dispatch_async(dispatch_get_main_queue(), ^{
            [self->_condition lock];
            void (^ready)(NSData *, NSError *) = self->_ready; self->_ready = nil;
            NSArray *waiters = [self->_stopWaiters copy]; [self->_stopWaiters removeAllObjects];
            self->_busy = NO;
            [self->_condition unlock];
            NSError *error = success ? nil : HostError(5, @"Embedded Python failed. Verify the signed runtime bundle and private data directory.");
            if (self.didExitHandler) self.didExitHandler(error);
            if (ready) ready(nil, error ?: HostError(6, @"Backend exited before readiness."));
            for (void (^waiter)(NSError *) in waiters) waiter(error);
        });
        // Idle owner survives for process lifetime; no Py_Finalize or thread kill.
    }}
}
@end
