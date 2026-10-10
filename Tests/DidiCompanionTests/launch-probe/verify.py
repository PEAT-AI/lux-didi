import json
import os
import signal
import sys


def verify(d, case):
    assert d['case'] == case and d['identityVerified'] is True
    assert d['registeredBeforeRelease'] is True and d['released'] is True
    assert d['kernel']['filter'] == -5 and d['kernel']['flags'] & 0x80000000
    assert d['kernel']['statusRequested'] is True
    assert d['observerPid'] != d['identity']['pid'] and d['identity']['uid'] == os.getuid()
    assert d['identity']['startSeconds'] > 0 and d['identity']['nonce']
    assert d['identity']['bundleURL'] == d['bundleURL']
    assert d['identity']['executable'] == d['bundleURL'] + '/Contents/MacOS/LaunchProbe'
    raw = d['kernel']['rawStatus']
    if case == 'signal':
        assert os.WIFSIGNALED(raw) and os.WTERMSIG(raw) == signal.SIGTERM
    else:
        assert os.WIFEXITED(raw) and os.WEXITSTATUS(raw) == int(case)
    assert d['observerDisposed'] is True


if __name__ == '__main__':
    reports = []
    for case in ('0', '42', 'signal'):
        path = os.path.join(sys.argv[1], case, 'observer.json')
        assert os.stat(path).st_mode & 0o777 == 0o600
        d = json.load(open(path))
        verify(d, case)
        # Missing status, identity, registration or cleanup must never become exit0.
        for key in ('identityVerified', 'registeredBeforeRelease', 'released', 'observerDisposed'):
            invalid = dict(d, **{key: False})
            try:
                verify(invalid, case)
            except AssertionError:
                pass
            else:
                raise AssertionError('invalid evidence accepted: ' + key)
        reports.append(d)
    assert len({d['kernel']['rawStatus'] for d in reports}) == 3
    print('PASS: own LaunchServices kernel exits distinguish 0, 42 and SIGTERM; invalid evidence rejected')
