#include <stdint.h>
#include <sys/types.h>
typedef struct { pid_t pid, parent; uid_t uid; uint64_t seconds, microseconds; } ProbeIdentity;
int probe_identity(pid_t pid, ProbeIdentity *identity, char *path, int length);
int probe_register(pid_t pid);
int probe_wait(int fd, int seconds, int64_t *status, uint32_t *flags, int16_t *filter);
int probe_cleanup(ProbeIdentity identity, const char *path);
int probe_connect(const char *path);
