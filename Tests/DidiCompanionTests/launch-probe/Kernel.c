#include "Kernel.h"
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/event.h>
#include <errno.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <fcntl.h>
#include <string.h>
#include <unistd.h>
int probe_identity(pid_t pid, ProbeIdentity *identity, char *path, int length) {
    struct proc_bsdinfo b;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &b, sizeof(b)) != sizeof(b) ||
        proc_pidpath(pid, path, length) <= 0) return -1;
    *identity = (ProbeIdentity){b.pbi_pid, b.pbi_ppid, b.pbi_uid, b.pbi_start_tvsec, b.pbi_start_tvusec};
    return 0;
}
int probe_register(pid_t pid) {
    int fd = kqueue();
    if (fd < 0) return -1;
    struct kevent event;
    EV_SET(&event, pid, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_ONESHOT, NOTE_EXIT | NOTE_EXITSTATUS, 0, NULL);
    if (kevent(fd, &event, 1, NULL, 0, NULL) < 0) { int error = errno; close(fd); errno = error; return -1; }
    return fd;
}
int probe_wait(int fd, int seconds, int64_t *status, uint32_t *flags, int16_t *filter) {
    struct kevent event;
    struct timespec deadline = {seconds, 0};
    int count = kevent(fd, NULL, 0, &event, 1, &deadline);
    if (count != 1) { if (count == 0) errno = ETIMEDOUT; return -1; }
    if (event.flags & EV_ERROR || event.filter != EVFILT_PROC || !(event.fflags & NOTE_EXIT)) { errno = EIO; return -1; }
    *status = event.data; *flags = event.fflags; *filter = event.filter;
    return 0;
}
int probe_cleanup(ProbeIdentity identity, const char *path) {
    ProbeIdentity current; char actual[PROC_PIDPATHINFO_MAXSIZE];
    if (probe_identity(identity.pid, &current, actual, sizeof(actual)) < 0) return 0;
    if (current.uid != getuid() || current.seconds != identity.seconds ||
        current.microseconds != identity.microseconds || strcmp(path, actual)) { errno = EPERM; return -1; }
    return kill(identity.pid, SIGTERM);
}

int probe_connect(const char *path) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_un address = {0}; address.sun_family = AF_UNIX;
    if (strlen(path) >= sizeof(address.sun_path)) { close(fd); errno = ENAMETOOLONG; return -1; }
    strcpy(address.sun_path, path);
    if (connect(fd, (struct sockaddr *)&address, sizeof(address)) < 0) { int e = errno; close(fd); errno = e; return -1; }
    return fd;
}
