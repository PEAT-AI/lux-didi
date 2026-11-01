# Voice alarms

Say “wake me at 8”, “set an alarm for tomorrow morning at eight”, or “wake me in eight hours”. Naya confirms only after the host commits the alarm. An unqualified “set an alarm at 8” asks for morning or evening first. “Wake me” permits the morning default.

These are **awake-Mac alarms**, not a replacement for a hardware alarm clock. A closed lid, manual sleep, shutdown, unavailable audio output or host failure can prevent ringing; a quit app is brought back for the next alarm ([Waking a quit app](#waking-a-quit-app-107)). The app prevents idle system sleep while alarms are pending or ringing; it does not override a closed lid or manual sleep, change devices or change system volume. Notification delivery is best effort.

## Tools and authority

| Tool | Behavior |
| --- | --- |
| `set_alarm` | Takes the model's structured `time` and the owner's words of the current ask, resolves one instant in a real IANA zone, and commits a pending alarm. |
| `list_alarms` | Lists pending and ringing alarms. |
| `cancel_alarm` | Cancels one armed alarm, or lists them when several are armed, only with a fresh finalized spoken cancellation request. |
| `snooze_alarm` | Completes the old occurrence and creates a new pending alarm atomically, from the same `time` shape. |

Set, cancel and snooze never derive authority from model output, typed text, host notes or alarm setup instructions. The ask may span the last two finalized owner turns, provided the latest turn continues the alarm request. An unrelated newer turn, a consumed request or a request older than two minutes cannot authorize a mutation.

## The time contract

The model states the time as a closed object and never converts to UTC: `{mode:"wall", date:{kind:"today"|"tomorrow"|"next_weekday",weekday?}|{kind:"iso",value}, local_time:"HH:MM", timezone?}` or `{mode:"relative", amount, unit:"minutes"|"hours"}`. `create_event` takes the same object plus an optional duration. The host converts the wall clock with `Intl` in its own IANA zone, or in the zone the model named when the owner named one. Each committed alarm stores that zone and a fixed UTC instant; travel and later time-zone changes do not move it.

A narrow checker, `server/tools/time-check.ts`, reads the owner's words of the current ask only. It recognizes anchored clocks ("at 6 pm", "18:00", "eighteen hundred", "half past six", "quarter to seven", "ten to seven", "noon"), day words and simple spans ("in ten minutes"). It never takes the first number of a sentence, so "one-time", "one hour call" and a clock inside the reminder subject yield no clock.

The conflict rules are exact. One owner time executes, and the result names the correction when the model's field differed or was omitted. A partial owner reading combines with compatible model fields, and only the constrained fields are overridden. An inconclusive ask executes a valid model time and reads it back. When neither settles a time, or a bare hour has no model meridian, she asks once, for the time only.

A wall time with no stated date that already passed today is the next occurrence and is read back with its day. A stated "today" that already passed asks back and is never silently moved to tomorrow. A nonexistent daylight-saving wall time is refused rather than silently shifted.

Every commit result carries the weekday, date, local time, zone and alarm id, and she says that read-back as returned. The label is the model's `label` argument, capped at eighty characters; a missing label leaves the reminder empty and the owner's sentence is never stored as a label.

## Ringing and recovery

The host stores alarms through the existing tool schema migrations. Its injected-clock scheduler rechecks at startup, after every mutation, on shell reconnection and on wake, clock and time-zone events. A timer waits no longer than 60 seconds. Pending alarms less than 20 minutes late ring; older alarms become missed and are mentioned in the next ordinary session's setup instructions.

The pending-to-ringing transition and a ten-minute ringing deadline commit before the `alarm_due` frame. A restart replays the same occurrence only inside its saved deadline, without extending it. Multiple due alarms retain separate ids; the shell uses one chime output rather than stacking chimes. Snooze creates a new occurrence and cannot resurrect or snooze the old occurrence twice.

The shell immediately plays a short chime through the existing cached connecting-ring player, repeating every 45 seconds until acknowledged or the deadline. Provider failure does not stop that local loop. Finalized explicit confirmation in the announcing call acknowledges that alarm; a subsequent snooze or cancel still requires its own matching spoken intent.

### Alarm speech, release 10.4

A due alarm uses Naya's normal live persona, memory, calendar digest and research tools, with an alarm block appended to the normal instructions. She opens with the owner's name, the time and the reminder in her own words first ("Rob, it is 10:30, time for sport"), and gives a short day overview when the reminder asks for a brief, briefing, overview, rundown, check-in or what's on. The label comes from the owner's own words: "remind me to go to sport" stores `go to sport`, "brief me" and "give me a briefing" store a brief, and "check in with me in an hour about the deck" stores `the deck` on a relative alarm. An alarm does not receive the normal fresh-opening direction.

With no live call, the shell starts an alarm call. During an existing call it routes the alarm into that call immediately as a host note, with no competing chime. When an alarm call becomes live, any fallback chime stops. The notification fallback has the default sound. No sleeping-Mac guarantee is made.

The host requests a shorter, friendly wake line after 30 seconds without model audio and repeats until acknowledgement, snooze/cancel, or the ten-minute ring deadline. The host idle budget covers the ring deadline; an alarm allows one provider rebuild while that deadline remains open. Chimes remain the standalone fallback when no call is available.

Only finalized spoken awake/confirmation phrases such as "I'm awake", "I'm up", "got it", "done", "okay okay" or "stop", and explicit snooze/cancel requests, acknowledge an alarm. A mumble or unrelated call does not. The most recently announced alarm in that call owns the confirmation; other ringing alarms are untouched. After acknowledgement the call continues normally. Snooze/cancel still use the normal owner-authorized alarm tools.

## Shell status and honesty

The menu bar shows `Alarm 08:00` for the next active alarm. `!` marks failed power assertion, denied or failed notifications, or a disconnected shell. There is one best-effort local notification per pending alarm; ringing and terminal states remove it. The idle-sleep assertion is released when no pending or ringing alarms remain.

If the shell is unreachable, notification permission is denied or the power assertion fails when setting, the tool receipt says the alarm is committed but may not ring and gives the reason. Even a healthy receipt never promises that a sleeping Mac or closed lid will ring.

## Waking a quit app (10.7)

While any alarm is pending the app keeps exactly one user LaunchAgent,
`~/Library/LaunchAgents/ai.peat.lux-didi.alarm.plist`. Its `StartCalendarInterval` is the next due
time minus 60 seconds, and its program is `open -g -a <app> --args --alarm-relaunch`: it opens the app
in the background and never steals focus. The agent is rewritten on every alarm change and again on
quit, and removed when nothing is pending. `launchctl bootstrap` and `bootout` run through an
injected runner, so tests use a temporary domain and never touch the real one. `alarm_relaunch_scheduled`
carries `due_in_s` and is written only when launchd accepted the agent; a refused bootstrap is
`alarm_relaunch_failed`, never a schedule that claims an agent exists. The interval uses only the keys
launchd defines (Minute, Hour, Day, Month): an agent that fires is rewritten or removed by the app that
comes back.

A launch with `--alarm-relaunch` logs `launch_kind alarm_relaunch`, shows no window and takes no
focus, starts the host, and opens a live session only for the due alarm. Display sleep is fine:
the wake timer fires while the display is off. A closed lid or a manual sleep still blocks it, as
does a shutdown, and the agent cannot bring back a Mac that is not awake at the due time.

In a live call the alarm is never a chime and never a second conversation: the shell reads the
conversation's own state, and a session that is connecting, listening, speaking, muted, paused or
rebuilding receives the existing alarm-mode host note inside that call. Only an app with no session
opens one for the alarm.

## Diagnostics and verification

Alarm log events are `alarm_scheduler_started`, `alarm_set`, `alarm_due`, `alarm_ring_started`, `alarm_announced`, `alarm_acknowledged`, `alarm_missed`, `alarm_relaunch_scheduled`, `alarm_relaunch_removed`, `alarm_relaunch_failed` and `alarm_degraded`. `alarm_announced` carries `alarmId` and `mode` (`new_session` or `in_call`) and is written when the alarm block reaches the provider, which is the only proof that she was asked to speak. `alarm_degraded` with reason `notifications_not_asked` stays distinct from `notifications_denied`: the shell reports `not_asked` while the request runs and `allowed` or `denied` once it resolved, so a guess is never sent. `alarm_scheduler_started` is written once when the host arms the scheduler and carries only the pending alarm count. The other events contain only the alarm id, scheduled UTC milliseconds, actual UTC milliseconds and a closed reason code. Owner words, labels and display names are not included in these events.

`bash scripts/check-host.sh` compiles a temporary shell on macOS without launching it and runs the synthetic alarm matrix against an offline-packed host. The matrix uses a stub clock, fake provider and fake shell; no real audio or accounts are used. `bash scripts/check-live-session.sh` runs the parser, authority, storage, scheduler and log tests; `bash scripts/check-native-live.sh` exercises injected power, notification and audio-output policy. `bash scripts/check-docs.sh` verifies public documentation and prompt surfaces.

`scripts/run-installed-checks.sh <installed-target>` includes the same alarm round trip against that target's packaged host, using isolated synthetic state and a stub clock. It does not launch the installed app or read its owner state. Its other installed checks retain their own authorization requirements; do not invoke the aggregate against an owner's installation without approval.
