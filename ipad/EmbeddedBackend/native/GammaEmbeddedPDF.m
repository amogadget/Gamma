#import "GammaEmbeddedPDF.h"
#import <Foundation/Foundation.h>
#import <PDFKit/PDFKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#import <dispatch/dispatch.h>

// All PDFKit access (including release) is serialized on the caller's thread
// (Gamma's backend threadpool); this module does not dispatch to the main queue.
// Each entry owns an autorelease pool and drops the GIL before waiting for the
// native lock. Callers must not run expensive PDF work on the UI thread.
// Bounds: 256 MiB input, 4096 px/side, 8 Mi pixels/render, 512 px occupancy.
static const NSUInteger InputLimit = 256 * 1024 * 1024;
static const size_t PixelLimit = 8 * 1024 * 1024;
static const char *CapsuleName = "gamma.PDFDocument";

@interface GammaPDFHandle : NSObject
@property(nonatomic, strong) PDFDocument *document;
@end
@implementation GammaPDFHandle
@end

static NSRecursiveLock *PDFLock(void) {
    static NSRecursiveLock *lock;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ lock = [NSRecursiveLock new]; });
    return lock;
}

// A block may use native values only: never touch the Python API without GIL.
static BOOL Work(void (^body)(void)) {
    __block NSString *failure = nil;
    Py_BEGIN_ALLOW_THREADS
    @autoreleasepool {
        NSRecursiveLock *lock = PDFLock();
        [lock lock];
        @try { @autoreleasepool { body(); } }
        @catch (NSException *e) { failure = [e.reason copy] ?: @"PDFKit exception"; }
        @finally { [lock unlock]; }
    }
    Py_END_ALLOW_THREADS
    if (failure) {
        PyErr_SetString(PyExc_ValueError, failure.UTF8String);
        return NO;
    }
    return YES;
}
static void Fail(NSString *message) {
    @throw [NSException exceptionWithName:@"GammaPDFError" reason:message userInfo:nil];
}
static GammaPDFHandle *GammaHandleFromCapsule(PyObject *capsule) {
    return (__bridge GammaPDFHandle *)PyCapsule_GetPointer(capsule, CapsuleName);
}
static void Destroy(PyObject *capsule) {
    @autoreleasepool {
        void *pointer = PyCapsule_GetPointer(capsule, CapsuleName);
        if (!pointer) { PyErr_Clear(); return; }
        // Capsule still owns its handle while another call holds an argument
        // reference. Explicit close clears document, never frees the capsule.
        Py_BEGIN_ALLOW_THREADS
        @autoreleasepool {
            NSRecursiveLock *lock = PDFLock();
            [lock lock];
            @autoreleasepool {
                GammaPDFHandle *handle = (__bridge_transfer GammaPDFHandle *)pointer;
                handle.document = nil;
                handle = nil;
            }
            [lock unlock];
        }
        Py_END_ALLOW_THREADS
    }
}
static PDFPage *Page(GammaPDFHandle *handle, Py_ssize_t index) {
    if (!handle.document) Fail(@"PDF document is closed");
    if (index < 0 || (NSUInteger)index >= handle.document.pageCount) Fail(@"PDF page index out of range");
    PDFPage *page = [handle.document pageAtIndex:(NSUInteger)index];
    if (!page || !page.pageRef) Fail(@"PDF page cannot be loaded");
    return page;
}
static CGRect Crop(PDFPage *page) {
    CGPDFPageRef ref = page.pageRef;
    CGRect crop = CGRectIntersection(CGPDFPageGetBoxRect(ref, kCGPDFCropBox),
                                    CGPDFPageGetBoxRect(ref, kCGPDFMediaBox));
    if (CGRectIsNull(crop) || CGRectIsEmpty(crop) ||
        !isfinite(crop.origin.x) || !isfinite(crop.origin.y) ||
        !isfinite(crop.size.width) || !isfinite(crop.size.height)) Fail(@"Invalid PDF page box");
    return crop;
}
static int Rotation(PDFPage *page) {
    int rotation = ((CGPDFPageGetRotationAngle(page.pageRef) % 360) + 360) % 360;
    if (rotation % 90) Fail(@"Unsupported PDF rotation");
    return rotation;
}
static CGSize DisplaySize(PDFPage *page) {
    CGSize size = Crop(page).size;
    if (Rotation(page) % 180) size = CGSizeMake(size.height, size.width);
    return size;
}
static PyObject *OpenData(NSData *data) {
    __block GammaPDFHandle *handle;
    if (!Work(^{
        if (!data.length || data.length > InputLimit) Fail(@"PDF input exceeds limit or is empty");
        PDFDocument *doc = [[PDFDocument alloc] initWithData:data];
        if (!doc || doc.isLocked || !doc.pageCount) Fail(@"Invalid, empty or locked PDF");
        handle = [GammaPDFHandle new];
        handle.document = doc;
    })) return NULL;
    void *pointer = (__bridge_retained void *)handle;
    PyObject *capsule = PyCapsule_New(pointer, CapsuleName, Destroy);
    if (!capsule) {
        // Preserve the Python allocation error while releasing PDFKit under
        // the same native lock as every other document operation.
        Work(^{ handle.document = nil; });
        CFRelease(pointer);
    }
    return capsule;
}
static PyObject *OpenBytes(PyObject *self, PyObject *args) {
    @autoreleasepool {
        const char *bytes; Py_ssize_t length;
        if (!PyArg_ParseTuple(args, "y#", &bytes, &length)) return NULL;
        if (length <= 0 || (NSUInteger)length > InputLimit) {
            PyErr_SetString(PyExc_ValueError, "PDF input exceeds 256 MiB limit or is empty"); return NULL;
        }
        return OpenData([NSData dataWithBytes:bytes length:(NSUInteger)length]);
    }
}
static PyObject *OpenPath(PyObject *self, PyObject *args) {
    @autoreleasepool {
        PyObject *path;
        if (!PyArg_ParseTuple(args, "O&", PyUnicode_FSConverter, &path)) return NULL;
        // FSConverter rejects embedded NUL and supports os.PathLike. Read in
        // bounded chunks, even when the file grows after opening (no mmap).
        const char *filename = PyBytes_AS_STRING(path);
        __block NSMutableData *data;
        BOOL ok = Work(^{
            int fd = open(filename, O_RDONLY | O_NONBLOCK);
            if (fd < 0) Fail(@"Cannot open PDF path");
            struct stat info;
            if (fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_size <= 0 ||
                (uint64_t)info.st_size > InputLimit) {
                close(fd); Fail(@"PDF path must be a nonempty regular file within 256 MiB");
            }
            FILE *file = fdopen(fd, "rb");
            if (!file) { close(fd); Fail(@"Cannot read PDF path"); }
            @try {
                data = [NSMutableData data];
                unsigned char chunk[65536];
                size_t count;
                while ((count = fread(chunk, 1, sizeof(chunk), file))) {
                    if (data.length + count > InputLimit) Fail(@"PDF input exceeds 256 MiB limit");
                    [data appendBytes:chunk length:count];
                }
                if (ferror(file)) Fail(@"Cannot read PDF path");
            } @finally { fclose(file); }
        });
        Py_DECREF(path);
        return ok ? OpenData(data) : NULL;
    }
}
static PyObject *Close(PyObject *self, PyObject *capsule) {
    @autoreleasepool {
        GammaPDFHandle *handle = GammaHandleFromCapsule(capsule); if (!handle) return NULL;
        if (!Work(^{ handle.document = nil; })) return NULL;
        Py_RETURN_NONE;
    }
}
static PyObject *Count(PyObject *self, PyObject *capsule) {
    @autoreleasepool {
        GammaPDFHandle *handle = GammaHandleFromCapsule(capsule); if (!handle) return NULL;
        __block NSUInteger count;
        if (!Work(^{
            if (!handle.document) Fail(@"PDF document is closed");
            count = handle.document.pageCount;
        })) return NULL;
        return PyLong_FromSize_t(count);
    }
}
static PyObject *Geometry(PyObject *self, PyObject *args) {
    @autoreleasepool {
        PyObject *capsule; Py_ssize_t index;
        if (!PyArg_ParseTuple(args, "On", &capsule, &index)) return NULL;
        GammaPDFHandle *handle = GammaHandleFromCapsule(capsule); if (!handle) return NULL;
        __block CGRect crop; __block CGSize size; __block int rotation;
        if (!Work(^{ PDFPage *page = Page(handle, index); crop = Crop(page);
            size = DisplaySize(page); rotation = Rotation(page); })) return NULL;
        return Py_BuildValue("{s:(dddd),s:i,s:d,s:d}",
            "crop", (double)CGRectGetMinX(crop), (double)CGRectGetMinY(crop),
            (double)CGRectGetMaxX(crop), (double)CGRectGetMaxY(crop),
            "rotation", rotation, "width", (double)size.width, "height", (double)size.height);
    }
}
static PyObject *Text(PyObject *self, PyObject *args) {
    @autoreleasepool {
        PyObject *capsule; Py_ssize_t index;
        if (!PyArg_ParseTuple(args, "On", &capsule, &index)) return NULL;
        GammaPDFHandle *handle = GammaHandleFromCapsule(capsule); if (!handle) return NULL;
        __block NSData *utf8;
        if (!Work(^{ utf8 = [(Page(handle, index).string ?: @"") dataUsingEncoding:NSUTF8StringEncoding]; })) return NULL;
        if (!utf8) { PyErr_SetString(PyExc_ValueError, "PDF text is not valid Unicode"); return NULL; }
        return PyUnicode_DecodeUTF8(utf8.bytes, (Py_ssize_t)utf8.length, "strict");
    }
}

// Owns RGBA pixels, top row first, opaque white-composited (premultiplication
// therefore equals straight alpha). Exactly the same raster feeds area crops.
static NSData *Raster(PDFPage *page, double scale, size_t *width, size_t *height,
                      CGAffineTransform *userToPixel, double left, double bottom,
                      double right, double top) {
    CGSize size = DisplaySize(page);
    if (!isfinite(left) || !isfinite(bottom) || !isfinite(right) || !isfinite(top) ||
        left < 0 || bottom < 0 || right < 0 || top < 0 ||
        left + right >= size.width || bottom + top >= size.height)
        Fail(@"Invalid PDF crop margins");
    double fullW = ceil(size.width * scale), fullH = ceil(size.height * scale);
    double offsetX = ceil(left * scale), offsetY = ceil(top * scale);
    double w = fullW - offsetX - ceil(right * scale);
    double h = fullH - offsetY - ceil(bottom * scale);
    if (!isfinite(scale) || scale <= 0 || !isfinite(w) || !isfinite(h) ||
        w < 1 || h < 1 || w > 4096 || h > 4096 || w * h > PixelLimit)
        Fail(@"PDF raster exceeds 4096 side / 8 Mi pixel limit or has invalid scale");
    *width = (size_t)w; *height = (size_t)h;
    NSMutableData *pixels = [NSMutableData dataWithLength:*width * *height * 4];
    CGColorSpaceRef colors = CGColorSpaceCreateDeviceRGB();
    CGContextRef context = CGBitmapContextCreate(pixels.mutableBytes, *width, *height,
        8, *width * 4, colors, kCGBitmapByteOrder32Big | kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(colors);
    if (!context) Fail(@"Cannot allocate PDF bitmap context");
    @try {
        CGContextSetRGBFillColor(context, 1, 1, 1, 1);
        CGContextFillRect(context, CGRectMake(0, 0, w, h));
        // Use the exact crop + rotation mappings used by pdf_notes._frame.
        // This avoids a second implicit PDFKit rotation or centering transform.
        CGRect c = Crop(page); CGFloat x = c.origin.x, y = c.origin.y;
        CGFloat r = CGRectGetMaxX(c), t = CGRectGetMaxY(c);
        CGAffineTransform m;
        switch (Rotation(page)) {
            case 90: m = CGAffineTransformMake(0, 1, 1, 0, -y, -x); break;
            case 180: m = CGAffineTransformMake(-1, 0, 0, 1, r, -y); break;
            case 270: m = CGAffineTransformMake(0, -1, -1, 0, t, r); break;
            default: m = CGAffineTransformMake(1, 0, 0, -1, -x, t); break;
        }
        // Bitmap row zero is memory y=0. This maps PDF top-left to row zero.
        // Allocate only the cropped bitmap, never a zoomed whole-page buffer.
        m = CGAffineTransformConcat(m, CGAffineTransformMakeScale(fullW / size.width, fullH / size.height));
        m = CGAffineTransformConcat(m, CGAffineTransformMakeTranslation(-offsetX, -offsetY));
        *userToPixel = m;
        // Quartz user space is bottom-up even though bitmap memory starts at
        // its top row. Establish a top-down device space before applying the
        // PDF-to-display mapping; otherwise returned pixels are upside down.
        CGContextTranslateCTM(context, 0, h);
        CGContextScaleCTM(context, 1, -1);
        CGContextConcatCTM(context, m);
        CGContextClipToRect(context, c);
        CGContextDrawPDFPage(context, page.pageRef);
    } @finally { CGContextRelease(context); }
    return pixels;
}
static PyObject *Render(PyObject *self, PyObject *args) {
    @autoreleasepool {
        PyObject *capsule; Py_ssize_t index; double scale;
        double left = 0, bottom = 0, right = 0, top = 0;
        if (!PyArg_ParseTuple(args, "Ond|dddd", &capsule, &index, &scale,
                             &left, &bottom, &right, &top)) return NULL;
        GammaPDFHandle *handle = GammaHandleFromCapsule(capsule); if (!handle) return NULL;
        __block NSData *pixels; __block size_t w, h;
        if (!Work(^{ CGAffineTransform m; pixels = Raster(Page(handle, index), scale, &w, &h, &m, left, bottom, right, top); })) return NULL;
        return Py_BuildValue("{s:n,s:n,s:n,s:i,s:y#}", "width", (Py_ssize_t)w,
            "height", (Py_ssize_t)h, "stride", (Py_ssize_t)(w * 4), "n_channels", 4,
            "buffer", pixels.bytes, (Py_ssize_t)pixels.length);
    }
}

// Raster ESTIMATE, not PDFium object enumeration: images, vectors, text and
// nested forms all participate. Edge-median background avoids treating a
// uniform colored page as thousands of occupied cells. Nonuniform edges use
// white (conservative). Very faint/subpixel content can still be missed; this
// is not a proof that a placement is collision-free. No whole-page bbox is
// emitted: pdf_notes deliberately discards objects covering >60% of a page.
static PyObject *Occupancy(PyObject *self, PyObject *args) {
    @autoreleasepool {
        PyObject *capsule; Py_ssize_t index;
        if (!PyArg_ParseTuple(args, "On", &capsule, &index)) return NULL;
        GammaPDFHandle *handle = GammaHandleFromCapsule(capsule); if (!handle) return NULL;
        __block NSMutableArray<NSValue *> *boxes;
        if (!Work(^{
            PDFPage *page = Page(handle, index); CGSize size = DisplaySize(page);
            size_t w, h; CGAffineTransform m;
            NSData *raster = Raster(page, 512.0 / MAX(size.width, size.height), &w, &h, &m, 0, 0, 0, 0);
            const unsigned char *p = raster.bytes;
            NSUInteger histogram[3][256] = {{0}}; NSUInteger samples = 0;
            for (size_t yy = 0; yy < h; yy++) for (size_t xx = 0; xx < w; xx++) {
                if (xx && yy && xx != w-1 && yy != h-1) continue;
                const unsigned char *q = p + (yy*w+xx)*4;
                for (int c = 0; c < 3; c++) histogram[c][q[c]]++;
                samples++;
            }
            int background[3];
            for (int c = 0; c < 3; c++) {
                NSUInteger sum = 0; background[c] = 255;
                for (int v = 0; v < 256; v++) { sum += histogram[c][v];
                    if (sum > samples/2) { background[c] = v; break; } }
            }
            NSUInteger matches = 0;
            for (size_t yy = 0; yy < h; yy++) for (size_t xx = 0; xx < w; xx++) {
                if (xx && yy && xx != w-1 && yy != h-1) continue;
                const unsigned char *q = p + (yy*w+xx)*4;
                if (abs(q[0]-background[0]) <= 8 && abs(q[1]-background[1]) <= 8 && abs(q[2]-background[2]) <= 8) matches++;
            }
            if (matches < samples * .95) background[0] = background[1] = background[2] = 255;
            CGAffineTransform inverse = CGAffineTransformInvert(m);
            boxes = [NSMutableArray array];
            for (size_t yy = 0; yy < h; yy += 8) for (size_t xx = 0; xx < w; xx += 8) {
                BOOL occupied = NO;
                for (size_t y = yy; y < MIN(yy+8,h) && !occupied; y++)
                    for (size_t x = xx; x < MIN(xx+8,w); x++) {
                        const unsigned char *q = p + (y*w+x)*4;
                        if (abs(q[0]-background[0]) > 8 || abs(q[1]-background[1]) > 8 || abs(q[2]-background[2]) > 8) { occupied = YES; break; }
                    }
                if (!occupied) continue;
                // Expand one pixel around each occupied cell, preserving crop.
                CGFloat x0 = xx ? xx-1 : 0, y0 = yy ? yy-1 : 0;
                CGRect rect = CGRectMake(x0, y0, MIN(xx+9,w)-x0, MIN(yy+9,h)-y0);
                rect = CGRectApplyAffineTransform(rect, inverse);
                [boxes addObject:[NSValue valueWithCGRect:rect]];
            }
        })) return NULL;
        PyObject *result = PyList_New((Py_ssize_t)boxes.count); if (!result) return NULL;
        for (NSUInteger i = 0; i < boxes.count; i++) {
            CGRect r = boxes[i].CGRectValue;
            PyObject *box = Py_BuildValue("(dddd)", (double)CGRectGetMinX(r), (double)CGRectGetMinY(r), (double)CGRectGetMaxX(r), (double)CGRectGetMaxY(r));
            if (!box) { Py_DECREF(result); return NULL; }
            PyList_SET_ITEM(result, (Py_ssize_t)i, box);
        }
        return result;
    }
}
static PyObject *Outline(PyObject *self, PyObject *capsule) {
    @autoreleasepool {
        GammaPDFHandle *handle = GammaHandleFromCapsule(capsule); if (!handle) return NULL;
        __block NSMutableArray<NSArray *> *entries;
        if (!Work(^{
            if (!handle.document) Fail(@"PDF document is closed");
            entries = [NSMutableArray array];
            PDFOutline *root = handle.document.outlineRoot;
            // Iterative preorder preserves arbitrarily nested bookmark levels.
            NSMutableArray<NSArray *> *stack = [NSMutableArray array];
            for (NSInteger i = (NSInteger)root.numberOfChildren - 1; i >= 0; i--)
                [stack addObject:@[[root childAtIndex:(NSUInteger)i], @0]];
            while (stack.count) {
                NSArray *next = stack.lastObject; [stack removeLastObject];
                PDFOutline *item = next[0]; NSNumber *level = next[1];
                PDFDestination *dest = item.destination;
                if (!dest && [item.action isKindOfClass:[PDFActionGoTo class]])
                    dest = ((PDFActionGoTo *)item.action).destination;
                NSUInteger index = dest.page ? [handle.document indexForPage:dest.page] : NSNotFound;
                [entries addObject:@[level, item.label ?: @"",
                    index == NSNotFound ? (id)[NSNull null] : @(index)]];
                for (NSInteger i = (NSInteger)item.numberOfChildren - 1; i >= 0; i--)
                    [stack addObject:@[[item childAtIndex:(NSUInteger)i], @(level.integerValue + 1)]];
            }
        })) return NULL;
        PyObject *result = PyList_New((Py_ssize_t)entries.count); if (!result) return NULL;
        for (NSUInteger i = 0; i < entries.count; i++) {
            NSArray *entry = entries[i];
            PyObject *index = entry[2] == [NSNull null] ? Py_NewRef(Py_None) :
                PyLong_FromUnsignedLongLong([entry[2] unsignedLongLongValue]);
            if (!index) { Py_DECREF(result); return NULL; }
            PyObject *row = Py_BuildValue("(nsN)", (Py_ssize_t)[entry[0] integerValue],
                                         [entry[1] UTF8String], index);
            if (!row) { Py_DECREF(result); return NULL; }
            PyList_SET_ITEM(result, (Py_ssize_t)i, row);
        }
        return result;
    }
}
static PyMethodDef Methods[] = {
    {"outline", Outline, METH_O, "Preorder (zero-based level, title, page index or None) bookmarks."},
    {"open_data", OpenBytes, METH_VARARGS, "Open immutable PDF bytes; return owning capsule."},
    {"open_path", OpenPath, METH_VARARGS, "Read a local PDF path within the input cap."},
    {"close", Close, METH_O, "Idempotently release document; invalidate dependent pages."},
    {"page_count", Count, METH_O, "Actual native page count (not capped)."},
    {"page_geometry", Geometry, METH_VARARGS, "Crop in PDF user space, rotation, display width/height."},
    {"page_text", Text, METH_VARARGS, "PDFKit Unicode text; no OCR."},
    {"render", Render, METH_VARARGS, "Top-down opaque RGBA buffer and explicit layout."},
    {"occupancy", Occupancy, METH_VARARGS, "Estimated occupied cells in unrotated PDF user space."},
    {NULL, NULL, 0, NULL}
};
static struct PyModuleDef Module = { PyModuleDef_HEAD_INIT, "_gamma_ios_pdf",
    "Bounded PDFKit/CoreGraphics read-only provider for embedded Gamma.", -1, Methods };
PyMODINIT_FUNC PyInit__gamma_ios_pdf(void) {
    @autoreleasepool { return PyModule_Create(&Module); }
}
