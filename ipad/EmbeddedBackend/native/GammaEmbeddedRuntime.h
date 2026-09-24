#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN
/// Process-owned CPython. All public methods and completions run on the main queue.
/// JSON contains credentials: never log, persist, or pass to JavaScript.
@interface GammaEmbeddedRuntime : NSObject
+ (instancetype)sharedRuntime NS_SWIFT_NAME(shared());
- (instancetype)init NS_UNAVAILABLE;
/// Main-queue notification for every serve return, including unexpected exits.
@property (nonatomic, copy, nullable) void (^didExitHandler)(NSError * _Nullable error);
- (void)startWithDataRoot:(NSURL *)dataRoot
              completion:(void (^)(NSData * _Nullable bootstrapJSON, NSError * _Nullable error))completion
    NS_SWIFT_NAME(start(dataRoot:completion:));
/// Bounded acknowledgement. Timeout does NOT mean backend threads have exited.
- (void)stopWithCompletion:(void (^)(NSError * _Nullable error))completion
    NS_SWIFT_NAME(stop(completion:));
@end
NS_ASSUME_NONNULL_END
