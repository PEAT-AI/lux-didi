import json
import os
import signal
import sys


def verify_held(root, failure=False):
    modes = ('held-http-failure',) if failure else (
        'held-premature', 'held-premature-released', 'held-wrong-stage', 'held-stale',
        'held-duplicate', 'held-cancel', 'held-eof', 'held-positive')
    for mode in modes:
        directory = root if failure else os.path.join(root, mode)
        if failure:
            assert open(os.path.join(directory, 'script-status')).read().strip() == '23'
            assert json.load(open(os.path.join(directory, 'status.json')))['data']['assistant']['id']
        d = json.load(open(os.path.join(directory, 'observer.json')))
        native = json.load(open(os.path.join(directory, 'native-disposed.json')))
        assert d['identityVerified'] and d['registeredBeforeRelease']
        assert d['nativeDisposed'] and not d['forced']
        assert d['kernel']['statusRequested'] and d['kernel']['filter'] == -5
        raw = d['kernel']['rawStatus']
        assert os.WIFEXITED(raw) and os.WEXITSTATUS(raw) == (0 if mode == 'held-positive' else 1)
        assert native['nonce'] == d['identity']['nonce'] and native['pid'] == d['identity']['pid']
        assert native['observationRequested'] is True
        if mode not in ('held-premature', 'held-premature-released'):
            stage = d['heldStage']
            assert d['heldStimulusSent'] and native['observationPublished']
            assert stage['nonce'] == native['nonce'] and stage['pid'] == native['pid']
            assert stage['stage'] and stage['stage'] == native['observationStage']
            assert d['serviceIdentity']['pid'] != native['pid']
            assert d['serviceKernel']['statusRequested'] and d['serviceKernel']['filter'] == -5
        else:
            assert not native['observationPublished'] and not native['observationAcknowledged']
            assert d['released'] == (mode == 'held-premature-released')
        assert native['observationAcknowledged'] == (mode == 'held-positive')
        assert native['cancelled'] == (mode != 'held-positive')
    print('PASS: actual native held gate accepts one bound ack; premature/wrong/stale/duplicate/cancel/EOF fail with owned cleanup')


def verify(d, case):
    assert d['case'] == case and d['identityVerified'] is True
    assert d['registeredBeforeRelease'] is True and d['released'] is True
    assert d['kernel']['filter'] == -5 and d['kernel']['flags'] & 0x80000000
    assert d['kernel']['statusRequested'] is True
    assert d['observerPid'] != d['identity']['pid'] and d['identity']['uid'] == os.getuid()
    assert d['identity']['startSeconds'] > 0 and d['identity']['nonce']
    assert d['identity']['bundleURL'] == d['bundleURL']
    assert d['identity']['executable'] == os.path.realpath(d['bundleURL'] + '/Contents/MacOS/LaunchProbe')
    assert os.path.realpath(d['identity']['rawExecutable']) == d['identity']['executable']
    raw = d['kernel']['rawStatus']
    if case == 'signal':
        assert os.WIFSIGNALED(raw) and os.WTERMSIG(raw) == signal.SIGTERM
    else:
        assert os.WIFEXITED(raw) and os.WEXITSTATUS(raw) == int(case)
    assert d['observerDisposed'] is True


if __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] in ('--held', '--held-failure'):
    verify_held(sys.argv[2], failure=sys.argv[1] == '--held-failure')
    sys.exit(0)

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
