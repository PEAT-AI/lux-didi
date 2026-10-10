#!/bin/bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
app="$1"; proof="$2"; node="$3"
work="$(mktemp -d "${TMPDIR:-/tmp}/didi-native-real-host.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir "$work/source" "$proof/real-host"
chmod 700 "$proof/real-host"
git archive HEAD server web | tar -x -C "$work/source"
# Build accepted owner bytes in disposable staging, never copy PACKAGE implementation.
# Offline/null npm config prevents cloud calls and reading real npm credentials.
export npm_config_userconfig=/dev/null npm_config_globalconfig="$work/absent-global-config"
cache="${LUX_COMPANION_NPM_CACHE:?explicit warmed npm cache required}"
npm --prefix "$work/source/server" ci --offline --ignore-scripts --no-audit --no-fund --cache "$cache"
npm --prefix "$work/source/web" ci --offline --ignore-scripts --no-audit --no-fund --cache "$cache"
"$node" "$work/source/server/node_modules/typescript/bin/tsc" -p "$work/source/server/tsconfig.json"
npm --prefix "$work/source/web" run build
resources="$app/Contents/Resources"
mkdir -p "$resources/server" "$resources/web"
cp -R "$work/source/server/dist" "$work/source/server/node_modules" "$resources/server/"
cp "$work/source/server/package.json" "$resources/server/"
cp -R "$work/source/web/dist" "$resources/web/"
commit="$(git rev-parse HEAD)"
python3 - "$resources" "$node" "$commit" <<'PY'
import json,sys,uuid,os
resources,node,commit=sys.argv[1:]
with open(resources+'/didi-runtime.json','w') as f:
 json.dump(dict(schemaVersion=1,installId=str(uuid.uuid4()),releaseCommit=commit,nodePath=os.path.realpath(node),nodeMajor=26,serverEntry='server/dist/host/index.js',webRoot='web/dist'),f)
PY
codesign --force --sign - --entitlements Resources/LuxDidi.entitlements "$app"
codesign --verify --strict "$app"
state="$proof/real-host/state"
for n in 1 2; do
 mkdir -p "$proof/real-host/launch-$n"
 "${LUX_VERIFICATION_DRIVER:?}" --verification "$app" "$proof/real-host/launch-$n" "$(uuidgen)" run --installed-proof --proof-state "$state" --proof-report "$proof/real-host/run-$n.json"
done
# Same exact signed artifact moved, same installId and marked actual domain data.
mv "$app" "$work/Moved Didi.app"
mkdir -p "$proof/real-host/launch-3"
"${LUX_VERIFICATION_DRIVER:?}" --verification "$work/Moved Didi.app" "$proof/real-host/launch-3" "$(uuidgen)" run --installed-proof --proof-state "$state" --proof-report "$proof/real-host/run-3.json"
# Real native cancellation before release and after actual owned service start.
# No SQL fixtures, sleeps or unchanged-source retries; same disposable marked identity.
for mode in cancel-pre eof-pre bad-nonce cancel-service eof-service; do
 mkdir -p "$proof/real-host/$mode"
 "${LUX_VERIFICATION_DRIVER:?}" --verification "$work/Moved Didi.app" "$proof/real-host/$mode" "$(uuidgen)" "$mode" --installed-proof --proof-state "$state" --proof-report "$proof/real-host/$mode.json"
done
python3 - "$proof/real-host" "$commit" <<'PY'
import json,sys,os
root,commit=sys.argv[1:]
reports=[json.load(open(f'{root}/run-{n}.json')) for n in (1,2,3)]
def valid_launch(launch, native_pid, node_pid):
 assert launch['identity']['pid']==native_pid and launch['observerPid']!=native_pid
 assert launch['registeredBeforeRelease'] and launch['identityVerified'] and launch['released']
 assert launch['kernel']['flags'] & 0x84000000 == 0x84000000 and launch['kernel']['rawStatus']==0
 assert launch['serviceIdentity']['pid']==node_pid and node_pid not in (native_pid,launch['observerPid'])
 assert launch['serviceKernel']['rawStatus']==0 and launch['nativeDisposed'] and launch['observerDisposed'] and not launch['forced']
for i,r in enumerate(reports):
 assert set(r)==set('type schemaVersion phase success runId installId proofId reopened source native service priorRecords newRecord observations visual serviceStop credentialCleanup error'.split())
 assert set(r['visual'])==set('windowId screenCapturePermission pageSnapshot nativeChrome nativeChromeLimitation accessibility rootVisualReviewRequired'.split())
 diagnostic=json.load(open(f'{root}/run-{i+1}.json.diagnostics.json'))
 assert diagnostic['nativePid']==r['native']['pid'] and diagnostic['windowId']==r['visual']['windowId']
 assert diagnostic['sourceSHA']==commit and diagnostic['proofId']==r['proofId']
 assert all(k in diagnostic for k in ('axConsumer','axDirectTrace','wkDiagnostics'))
 assert diagnostic['axConsumer']['queryOnMainThread'] is True
 readiness=diagnostic['axConsumer']['windowReadiness']
 assert readiness['ready'] is True
 assert readiness['nativePid']==r['native']['pid'] and readiness['windowId']==r['visual']['windowId']
 assert all(readiness['events'][-1]['state'].values()), 'native AppKit window was not ready before AX/SCK'
 context=readiness['diagnostics']['context']; activation=readiness['diagnostics']['activation']; loop=readiness['diagnostics']['runLoop']
 assert isinstance(context['frontmostIsSelf'],bool) and context['parentPid']>0
 assert activation['api']=='NSRunningApplication.activate(options:[])' and activation['semantics']=='request-sent-not-readiness'
 assert isinstance(activation['attempted'],bool) and (isinstance(activation['requestSent'],bool) if activation['attempted'] else activation['requestSent'] is None)
 assert loop['disposed'] is True and loop['count']>=0
 assert (loop['firstUptimeNanoseconds'] is None and loop['lastUptimeNanoseconds'] is None) if loop['count']==0 else 0 < loop['firstUptimeNanoseconds'] <= loop['lastUptimeNanoseconds']
 assert r['type']=='LuxDidiInstalledProof' and r['schemaVersion']==1
 assert r['phase']=='complete' and r['success'] is True
 launch=json.load(open(os.path.join(root,'launch-'+str(i+1),'observer.json')))
 assert launch['identity']['pid']==r['native']['pid'] and launch['identity']['uid']==os.getuid()
 assert launch['identityVerified'] and launch['registeredBeforeRelease'] and launch['released'] and launch['observerDisposed']
 assert launch['kernel']['filter']==-5 and launch['kernel']['flags'] & 0x84000000 == 0x84000000
 assert os.WIFEXITED(launch['kernel']['rawStatus']) and os.WEXITSTATUS(launch['kernel']['rawStatus'])==0
 assert launch['serviceIdentity']['pid']==r['service']['pid'] and launch['serviceIdentity']['pid']!=r['native']['pid']
 assert launch['serviceKernel']['flags'] & 0x84000000 == 0x84000000 and launch['serviceKernel']['rawStatus']==0
 assert launch['forced'] is False and launch['releaseState'] and launch['nativeDisposed'] is True
 assert launch['pidReuseRefused'] and launch['driverMixupRefused']
 assert launch['bundleURL']==os.path.realpath(r['source']['bundlePath'])
 valid_launch(launch,r['native']['pid'],r['service']['pid'])
 # Consumer refusal controls use copies of actual evidence, never fake durable state.
 import copy
 for key,value in [('registration',False),('status',None),('flag',0),('native-node',r['service']['pid']),('driver-native',launch['observerPid']),('cleanup',False)]:
  rejected=copy.deepcopy(launch)
  if key=='registration': rejected['registeredBeforeRelease']=value
  elif key=='status': rejected['kernel']['rawStatus']=value
  elif key=='flag': rejected['kernel']['flags']=value
  elif key in ('native-node','driver-native'): rejected['identity']['pid']=value
  else: rejected['nativeDisposed']=value
  try: valid_launch(rejected,r['native']['pid'],r['service']['pid'])
  except AssertionError: pass
  else: raise AssertionError('accepted invalid '+key+' evidence')
 assert r['source']['releaseCommit']==commit
 assert r['service']['readyVerified'] and r['serviceStop']['observedExited']
 assert r['serviceStop']['pid']==r['service']['pid']
 assert r['credentialCleanup']['cleaned'] and r['newRecord']['visibleInCanonicalUI']
 assert r['native']['exitEvidence']=='external-driver-required' and 'exited' not in r['native']
 assert r['visual']['pageSnapshot'] and len(r['visual']['accessibility'])==3
 for previous in reports[:i]:
  expected=previous['newRecord']
  assert any(all(old[k]==expected[k] for k in ('sessionId','entryId','text')) and old['visibleInCanonicalUI'] for old in r['priorRecords'])
 assert r['proofId']==reports[0]['proofId'] and r['installId']==reports[0]['installId']
 assert all(r['service'][k]==reports[0]['service'][k] for k in ('assistantId','authorityEpoch'))
 assert len(r['priorRecords'])==i and r['reopened']==(i>0)
 try: os.kill(r['service']['pid'],0)
 except ProcessLookupError: pass
 else: raise AssertionError('owned HOST survived Quit')
assert reports[0]['source']['nativeExecutableSHA256']==reports[2]['source']['nativeExecutableSHA256']
assert reports[0]['source']['bundlePath']!=reports[2]['source']['bundlePath']
print('REAL-HOST-NATIVE PASS dependency-base=76255fc6c2b3a0c75949e492f063884906852b84 source='+commit+' nativeExits=external-observed-0 runs=3 priorRecords=0,1,2 installId=preserved relocation=observed ordinaryData=untouched installChain=not-claimed')
for mode in ('cancel-pre','eof-pre','bad-nonce','cancel-service','eof-service'):
 negative=json.load(open(f'{root}/{mode}.json'))
 launched=json.load(open(f'{root}/{mode}/observer.json'))
 assert negative['success'] is False and negative['phase']=='failed' and negative['error']
 assert launched['kernel']['rawStatus']==256 and launched['kernel']['flags'] & 0x84000000 == 0x84000000
 assert launched['identity']['pid']==negative['native']['pid']
 assert launched['observerDisposed'] and launched['nativeDisposed'] and launched['forced'] is False
 if mode.endswith('service'):
  assert launched['serviceIdentity']['pid']==negative['serviceStop']['pid']
  assert launched['serviceKernel']['rawStatus']==0 and launched['serviceKernel']['flags'] & 0x84000000 == 0x84000000
  assert negative['serviceStop']['exitObserved'] and negative['serviceStop']['terminationCode']==0
  assert negative['credentialCleanup']['cleaned']
 else:
  assert launched['released'] is False and launched['serviceIdentity'] is None
  assert negative['observations']['credentialImported'] is False
print('PASS: real gate cancellation/EOF/nonce refusal, awaited Node/credential cleanup and listener disposal')

PY
