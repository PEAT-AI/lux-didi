#import "AudioCallbackBridge.h"
#import <Foundation/Foundation.h>
bool DidiInvokeTapOffMain(AVAudioNodeTapBlock tap, AVAudioPCMBuffer *buffer) {
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    __block bool offMain = false;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        offMain = ![NSThread isMainThread];
        tap(buffer, [[AVAudioTime alloc] initWithSampleTime:0 atRate:48000]);
        dispatch_semaphore_signal(done);
    });
    return dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) == 0 && offMain;
}
