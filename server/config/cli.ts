import { setRouteClasses, type RouteClassOptions } from './route-classes.js';
import { initializeProviderConfig, migrateProviderBinding, ConfigError, type InitializeOptions, type MigrateBindingOptions } from './index.js';
import { isLiveVoiceProvider, type LiveVoiceProvider } from '../adapters/live-voice/index.js';
import { LiveConfigError } from '../live/types.js';
import { saveLiveSelection } from './live.js';
import { readFileSync, statSync } from 'node:fs';

const help = 'Usage: node <compiled-root>/config/cli.js init --config-dir <new-private-dir> --owner-id <current-store-owner> --profile-input <private-profile-json> --source-env <authorized-private-env-file> [--binding-input <private-binding-json>]\n       node <compiled-root>/config/cli.js migrate-binding --config-dir <existing-private-dir> --owner-id <current-store-owner> --surface <text|live> --binding-input <private-binding-json>\n       node <compiled-root>/config/cli.js select --config-dir <existing-private-dir> --provider <openai|gemini> [--voice <name|voice_id>] [--voice-description-file <absolute-path>] [--accent <selection>] [--playback-rate <1.0-1.2>]\n       node <compiled-root>/config/cli.js set-route-classes --config-dir <private-dir> --owner-id <owner> --surface <text|live> --binding-input <private-json> --expected-generation <previous> [--dry-run]\nAll paths must be explicit absolute paths. Fixed source variable: GEMINI_API_KEY. Binding is an operator assertion, not provider identity verification.\n';
type SelectOptions = { configDir: string; provider: LiveVoiceProvider; voice?: string; accent?: string; voiceDescription?: string; playbackRate?: number };
/** A voice description is at most 1,500 characters, so any file past this is not one. */
const maxDescriptionBytes = 8 * 1024;
function descriptionFrom(path: string): string {
  let stats;
  try { stats = statSync(path); } catch { throw new ConfigError('file_missing'); }
  if (!stats.isFile()) throw new ConfigError('file_type');
  if (stats.size > maxDescriptionBytes) throw new ConfigError('too_large');
  return readFileSync(path, 'utf8');
}
type Command = { command: 'set-route-classes'; options: RouteClassOptions } | { command: 'init'; options: InitializeOptions } | { command: 'migrate-binding'; options: MigrateBindingOptions }
  | { command: 'select'; options: SelectOptions };
function argumentsFrom(args: string[]): Command {
  const command = args[0];
  if (command === 'set-route-classes') {
    const values = new Map<string, string>(); let dryRun = false;
    for (let i = 1; i < args.length; i++) {
      const flag = args[i]!;
      if (flag === '--dry-run') { if (dryRun) throw new ConfigError('invalid_arguments'); dryRun = true; continue; }
      if (!['--config-dir', '--owner-id', '--surface', '--binding-input', '--expected-generation'].includes(flag) || values.has(flag)) throw new ConfigError('invalid_arguments');
      const value = args[++i]; if (!value || value.startsWith('--')) throw new ConfigError('invalid_arguments'); values.set(flag, value);
    }
    if (values.size !== 5 || !['text', 'live'].includes(values.get('--surface')!)) throw new ConfigError('invalid_arguments');
    return { command, options: { configDir: values.get('--config-dir')!, ownerId: values.get('--owner-id')!, surface: values.get('--surface')! as 'text' | 'live', bindingInputPath: values.get('--binding-input')!, expectedGeneration: values.get('--expected-generation')!, dryRun } };
  }
  if ((command !== 'init' && command !== 'migrate-binding' && command !== 'select') ||
      (command === 'init' ? ![9, 11, 13].includes(args.length)
        : command === 'select' ? ![5, 7, 9, 11, 13].includes(args.length) : args.length !== 9)) throw new ConfigError('invalid_arguments');
  const names: Record<string, string> = { '--config-dir': 'configDir', '--owner-id': 'ownerId', '--binding-input': 'bindingInputPath',
    ...(command === 'migrate-binding' ? { '--surface': 'surface' } : {}),
    ...(command === 'init' ? { '--profile-input': 'profileInputPath', '--source-env': 'sourceEnvPath', '--provider': 'provider' }
      : command === 'select' ? { '--provider': 'provider', '--voice': 'voice', '--accent': 'accent', '--playback-rate': 'playbackRate', '--voice-description-file': 'voiceDescriptionPath' } : {}) };
  const values: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i]!;
    const name = Object.hasOwn(names, flag) ? names[flag] : undefined;
    const value = args[i + 1];
    if (!name || !value || value.startsWith('--') || Object.hasOwn(values, name)) throw new ConfigError('invalid_arguments');
    values[name] = value;
  }
  if (command === 'select') {
    if (!values['configDir'] || !values['provider'] || !isLiveVoiceProvider(values['provider'])) throw new ConfigError('invalid_arguments');
    const descriptionPath = values['voiceDescriptionPath'];
    return { command, options: { configDir: values['configDir'], provider: values['provider'],
      ...(values['voice'] !== undefined ? { voice: values['voice'] } : {}),
      ...(values['accent'] !== undefined ? { accent: values['accent'] } : {}),
      ...(values['playbackRate'] !== undefined ? { playbackRate: Number(values['playbackRate']) } : {}),
      ...(descriptionPath !== undefined ? { voiceDescription: descriptionFrom(descriptionPath) } : {}) } };
  }
  if (!values['configDir'] || !values['ownerId']) throw new ConfigError('invalid_arguments');
  const common = { configDir: values['configDir'], ownerId: values['ownerId'] };
  if (command === 'migrate-binding') {
    if (!values['bindingInputPath'] || !['text', 'live'].includes(values['surface']!)) throw new ConfigError('invalid_arguments');
    return { command, options: { ...common, bindingInputPath: values['bindingInputPath'], surface: values['surface']! as 'text' | 'live' } };
  }
  if (!values['profileInputPath'] || !values['sourceEnvPath']) throw new ConfigError('invalid_arguments');
  const provider = values['provider'];
  if (provider !== undefined && !isLiveVoiceProvider(provider)) throw new ConfigError('invalid_arguments');
  return { command, options: { ...common, profileInputPath: values['profileInputPath'], sourceEnvPath: values['sourceEnvPath'],
    ...(values['bindingInputPath'] ? { bindingInputPath: values['bindingInputPath'] } : {}),
    ...(provider !== undefined ? { provider } : {}) } };
}
if (process.argv.slice(2).length === 1 && process.argv[2] === '--help') {
  process.stdout.write(help);
} else {
  try {
    const parsed = argumentsFrom(process.argv.slice(2));
    if (parsed.command === 'set-route-classes') {
      const result = setRouteClasses(parsed.options); process.stdout.write(JSON.stringify(result) + '\n');
    } else if (parsed.command === 'init') initializeProviderConfig(parsed.options);
    else if (parsed.command === 'select') saveLiveSelection(parsed.options);
    else await migrateProviderBinding(parsed.options);
    if (parsed.command !== 'set-route-classes') process.stdout.write(parsed.command === 'init' ? 'Provider configuration initialized.\n'
      : parsed.command === 'select' ? 'Live provider selection saved; it applies when the service next starts.\n'
      : 'Provider binding migrated. Sensitive legacy backup retained; profile and preferences unchanged.\n');
  } catch (e) {
    // A refused value names its own reason (invalid_voice, invalid_accent, file_missing) instead of the blanket code.
    const code = e instanceof ConfigError ? e.code : e instanceof LiveConfigError ? e.code : 'initialization_failed';
    process.stderr.write(`Provider configuration error: ${code}. Preserve protected configuration and any retained legacy backup for authorized inspection; failed migration may leave a valid old or new active record. Failed initialization requires a fresh destination.\n`);
    process.exitCode = 1;
  }
}
