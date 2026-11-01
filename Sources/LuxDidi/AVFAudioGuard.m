#import "AVFAudioGuard.h"

NSString *const DIDIAVFAudioExceptionNameKey = @"DIDIAVFAudioExceptionName";
NSString *const DIDIAVFAudioExceptionReasonKey = @"DIDIAVFAudioExceptionReason";

NSError *DIDIAVFAudioGuard(void (NS_NOESCAPE ^body)(void)) {
    if (body == nil) { return nil; }
    @try {
        body();
        return nil;
    } @catch (NSException *exception) {
        NSMutableDictionary *userInfo = [NSMutableDictionary dictionary];
        userInfo[DIDIAVFAudioExceptionNameKey] = exception.name ?: @"unknown";
        userInfo[DIDIAVFAudioExceptionReasonKey] = exception.reason ?: @"";
        userInfo[NSLocalizedDescriptionKey] = [NSString stringWithFormat:@"%@: %@",
                                              userInfo[DIDIAVFAudioExceptionNameKey],
                                              userInfo[DIDIAVFAudioExceptionReasonKey]];
        return [NSError errorWithDomain:@"DidiAVFAudioGuard" code:1 userInfo:userInfo];
    }
}

NSString *DIDIAVFAudioExceptionName(NSError *error) {
    NSString *name = error.userInfo[DIDIAVFAudioExceptionNameKey];
    return name.length > 0 ? name : @"unknown";
}
