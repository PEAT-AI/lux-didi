# Voice alarms

Say “wake me at 8”, “set an alarm for tomorrow morning at eight”, or “wake me in eight hours”. Naya confirms only after the host commits the alarm. An unqualified “set an alarm at 8” asks for morning or evening first. “Wake me” permits the morning default.

These are **awake-Mac alarms**, not a replacement for a hardware alarm clock. A closed lid, manual sleep, shutdown, app exit, unavailable audio output or host failure can prevent ringing. The app prevents idle system sleep while alarms are pending or ringing; it does not override a closed lid or manual sleep, change devices or change system volume. Notification delivery is best effort.

## Tools and authority

| Tool | Behavior |
| --- | --- |
| `set_alarm` | Parses the time from the owner's finalized microphone transcription and commits a pending alarm. |
| `list_alarms` | Lists pending and ringing alarms. |
| `cancel_alarm` | Cancels an active alarm only with a fresh finalized spoken cancellation request. |
| `snooze_alarm` | Completes the old occurrence and creates a new pending alarm atomically, from a fresh spoken duration or time. |

Set, cancel and snooze never derive authority from model output, typed text, host notes or alarm setup instructions. The ask may span the last two finalized owner turns, provided the latest turn continues the alarm request. An unrelated newer turn, a consumed request or a request older than two minutes cannot authorize a mutation.

The model's optional `fire_at_utc` argument is only a consistency check, with a 60-second tolerance for relative-time skew. The host uses its current IANA time zone to interpret the spoken request. Each committed alarm stores that zone and a fixed UTC instant; travel and later time-zone changes do not move it. A nonexistent daylight-saving wall time is refused rather than silently shifted.

## Ringing and recovery

The host stores alarms through the existing tool schema migrations. Its injected-clock scheduler rechecks at startup, after every mutation, on shell reconnection and on wake, clock and time-zone events. A timer waits no longer than 60 seconds. Pending alarms less than 20 minutes late ring; older alarms become missed and are mentioned in the next ordinary session's setup instructions.

The pending-to-ringing transition and a ten-minute ringing deadline commit before the `alarm_due` frame. A restart replays the same occurrence only inside its saved deadline, without extending it. Multiple due alarms retain separate ids; the shell uses one chime output rather than stacking chimes. Snooze creates a new occurrence and cannot resurrect or snooze the old occurrence twice.

The shell immediately plays a short chime through the existing cached connecting-ring player, repeating every 45 seconds until acknowledged or the deadline. Provider failure does not stop that local loop. Finalized credible owner speech acknowledges ringing; a subsequent snooze or cancel still requires its own matching spoken intent.

### Alarm speech, W11-R5

For an occurrence with no live conversation, the host reserves at most one provider-session attempt. Its **session setup instructions**, not a user-role message, contain alarm mode, the Mac account's display name and scheduled time. No calendar or mail lookup is requested. Automatic provider recovery is disabled for that alarm-mode session.

If a conversation is already live, the alarm is the local chime and menu-bar state only. The host neither injects text nor rebuilds the session. It records `alarm_degraded` with `live_session_no_channel`; the next finalized owner speech acknowledges the alarm. A general non-user note channel for live sessions remains separate work, not an alarm reliability dependency.

## Shell status and honesty

The menu bar shows `Alarm 08:00` for the next active alarm. `!` marks failed power assertion, denied or failed notifications, or a disconnected shell. There is one best-effort local notification per pending alarm; ringing and terminal states remove it. The idle-sleep assertion is released when no pending or ringing alarms remain.

If the shell is unreachable, notification permission is denied or the power assertion fails when setting, the tool receipt says the alarm is committed but may not ring and gives the reason. Even a healthy receipt never promises that a sleeping Mac or closed lid will ring.

## Diagnostics and verification

Alarm log events are `alarm_set`, `alarm_due`, `alarm_ring_started`, `alarm_acknowledged`, `alarm_missed` and `alarm_degraded`. They contain only the alarm id, scheduled UTC milliseconds, actual UTC milliseconds and a closed reason code. Owner words, labels and display names are not included in these events.

`bash scripts/check-host.sh` compiles a temporary shell on macOS without launching it and runs the synthetic alarm matrix against an offline-packed host. The matrix uses a stub clock, fake provider and fake shell; no real audio or accounts are used. `bash scripts/check-live-session.sh` runs the parser, authority, storage, scheduler and log tests; `bash scripts/check-native-live.sh` exercises injected power, notification and audio-output policy. `bash scripts/check-docs.sh` verifies public documentation and prompt surfaces.

`scripts/run-installed-checks.sh <installed-target>` includes the same alarm round trip against that target's packaged host, using isolated synthetic state and a stub clock. It does not launch the installed app or read its owner state. Its other installed checks retain their own authorization requirements; do not invoke the aggregate against an owner's installation without approval.
