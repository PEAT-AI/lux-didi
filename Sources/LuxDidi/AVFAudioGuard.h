#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// The user info key carrying an exception's name, so a Swift caller can journal which AVFAudio
/// check refused the call without parsing a message.
FOUNDATION_EXPORT NSString *const DIDIAVFAudioExceptionNameKey;
/// The user info key carrying the exception's reason text.
FOUNDATION_EXPORT NSString *const DIDIAVFAudioExceptionReasonKey;

/// Runs one thin AVFAudio call and catches the Objective-C exception AVFAudio raises for a bad
/// condition, returning it as an NSError. Only Objective-C can catch it: in Swift the exception
/// unwinds the frame and leaves the concurrency runtime's current executor pointing at a dead
/// stack, and the next MainActor.assumeIsolated jumps through it.
///
/// Returns nil when the call ran to completion. This is a boundary check, not a fallback: the Swift
/// caller throws, so the call ends loudly instead of leaving a corrupt process behind.
FOUNDATION_EXPORT NSError *_Nullable DIDIAVFAudioGuard(void (NS_NOESCAPE ^body)(void));

/// The exception name a guard failure carries, or "unknown", so Swift never parses a user info
/// dictionary it cannot see through.
FOUNDATION_EXPORT NSString *DIDIAVFAudioExceptionName(NSError *error);

NS_ASSUME_NONNULL_END
