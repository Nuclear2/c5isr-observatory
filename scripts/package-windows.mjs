// Called by package-windows.ps1. stdout carries the verified input inventory.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const [exe, sysroot, artifacts] = process.argv.slice(2);
const repo = process.cwd();
const target = 'x86_64-pc-windows-gnu';
const files = new Map();
function add(name, path = join(repo, name)) {
  if (files.has(name) || !/^[a-zA-Z0-9_./-]+$/.test(name) || name.includes('..') || name.startsWith('/')) {
    throw new Error('Invalid or duplicate package entry.');
  }
  files.set(name, path);
}

// Inspect PE headers directly. A stripped GNU PE has no COFF symbols, debug
// directory, certificate table, linker timestamp or non-system DLL imports.
const pe = readFileSync(exe);
const header = pe.readUInt32LE(0x3c);
const optional = header + 24;
if (pe.toString('ascii', 0, 2) !== 'MZ' || pe.readUInt32LE(header) !== 0x4550 ||
    pe.readUInt16LE(header + 4) !== 0x8664 || pe.readUInt16LE(optional) !== 0x20b ||
    pe.readUInt32LE(header + 8) !== 0 || pe.readUInt32LE(header + 16) !== 0 ||
    [4, 6, 13].some(index => pe.readBigUInt64LE(optional + 112 + index * 8) !== 0n)) {
  throw new Error('Expected a stripped, timestamp-free AMD64 PE without certificate, debug or delayed imports.');
}
const bundledInspector = join(sysroot, 'lib/rustlib', target, 'bin/llvm-objdump.exe');
const objdump = existsSync(bundledInspector) ? bundledInspector : 'objdump.exe';
const headers = execFileSync(objdump, ['-p', exe], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
const imports = [...new Set([...headers.matchAll(/DLL Name:\s*(\S+)/gi)].map(match => match[1].toLowerCase()))].sort();
const windowsDll = /^(?:(?:api-ms-win-[a-z0-9-]+)|(?:advapi32|bcrypt|bcryptprimitives|kernel32|msvcrt|ntdll|shell32|user32|userenv|ws2_32))\.dll$/;
if (!imports.length || imports.some(dll => !windowsDll.test(dll))) {
  throw new Error('Unexpected executable DLL imports: ' + imports.join(', '));
}
console.error('PE imports: ' + imports.join(', '));

add('C5ISR-Observatory.exe', exe);
add('LICENSE');
add('scripts/codex-bridge.mjs');
add('contracts/model-output.schema.json');
add('contracts/evidence-advice.schema.json');
add('dist/index.html');
const html = readFileSync('dist/index.html', 'utf8');
const refs = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(match => match[1]);
if (!refs.some(ref => ref.endsWith('.js')) || !refs.some(ref => ref.endsWith('.css'))) throw new Error('Missing web assets.');
for (const ref of refs) {
  if (!/^\/assets\/index-[A-Za-z0-9_-]+\.(?:js|css)$/.test(ref)) throw new Error('Unexpected asset in dist/index.html');
  add('dist' + ref);
}
for (const sample of ['examples/two-node-replay.json', 'examples/evidence-review.json']) {
  if (!readFileSync(sample).equals(readFileSync('dist/' + sample))) throw new Error('Built replay must match ' + sample);
  add('dist/' + sample);
}

// Collect upstream notices without serializing manifests or their source paths.
const notices = [];
function notice(title, path) {
  notices.push(title, readFileSync(path, 'utf8').replaceAll('\r\n', '\n').trimEnd(), '');
}
const project = JSON.parse(readFileSync('package.json', 'utf8'));
const npmSeen = new Set();
function npmNotices(dependencies, base) {
  const require = createRequire(base);
  for (const name of Object.keys(dependencies ?? {}).sort()) {
    const manifest = realpathSync(require.resolve(name + '/package.json'));
    if (npmSeen.has(manifest)) continue;
    npmSeen.add(manifest);
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    notice(pkg.name + ' ' + pkg.version, join(dirname(manifest), 'LICENSE'));
    npmNotices(pkg.dependencies, manifest);
  }
}
npmNotices(project.dependencies, join(repo, 'package.json'));
const cargo = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--offline', '--locked', '--filter-platform', target], {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
}));
for (const pkg of cargo.packages.filter(pkg => pkg.source).sort((a, b) => a.id.localeCompare(b.id, 'en'))) {
  const folder = dirname(pkg.manifest_path);
  const licenses = readdirSync(folder).filter(name => /^(?:(?:un)?license|notice)(?:$|[-.])/i.test(name)).sort();
  if (!licenses.length) throw new Error('Missing license for ' + pkg.name);
  for (const license of licenses) notice(pkg.name + ' ' + pkg.version + ' / ' + license, join(folder, license));
}
for (const file of ['COPYING.RUNTIME', 'COPYING3']) notice('GCC / ' + file, join(sysroot, 'share/doc', file));
const mingwNotice = process.env.MINGW_RUNTIME_NOTICE || join(repo, '.tools/w64devkit/COPYING.MinGW-w64-runtime.txt');
notice('MinGW-w64 runtime', mingwNotice);
const noticePath = join(artifacts, 'THIRD-PARTY-NOTICES.txt');
writeFileSync(noticePath, notices.join('\n') + '\n');
add('licenses/third-party.txt', noticePath);
add('licenses/rust-standard-library.html', join(sysroot, 'share/doc/rust/COPYRIGHT-library.html'));

// Read identifiers only for comparison, keeping them out of filenames, the
// inventory, error messages and the archive. Scan both UTF-16 alignments.
const machine = process.env;
const deviceAddresses = Object.values(networkInterfaces()).flat().filter(Boolean)
  .filter(nic => !nic.internal).flatMap(nic => [nic.mac, nic.mac.replaceAll(':', '-'), nic.address]);
const needles = [
  resolve(repo), sysroot, machine.USERPROFILE, machine.APPDATA, machine.LOCALAPPDATA, machine.COMPUTERNAME,
  machine.C5ISR_AUDIT_SID, machine.C5ISR_AUDIT_MACHINE_GUID, ...deviceAddresses.filter(value => !/^00[:-]00/.test(value)),
];
// Common account names can also occur in public license prose or minified JS.
// Match those through absolute profile paths and SID checks instead.
if (machine.USERNAME?.length >= 4 && !/^(user|root|admin|administrator|runner|build|test|system)$/i.test(machine.USERNAME)) {
  needles.push(machine.USERNAME);
}
function normalize(value) { return value.toLowerCase().replaceAll('\\\\', '/').replaceAll('\\', '/'); }
const privateValues = needles.filter(Boolean).map(normalize);
const sensitive = /(?:[a-z]:\/+users\/+[^/\s\x00]+\/|\/home\/[a-z0-9._-]+\/(?:\.cargo|\.ssh|\.codex)|s-1-5-21-\d+-\d+-\d+-\d+|-----begin (?:[a-z ]+ )?private key-----|gh[pousr]_[a-z0-9]{30,}|github_pat_[a-z0-9_]{45,}|sk-(?:proj-)?[a-z0-9_-]{32,})/i;
const entries = [];
for (const [name, path] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
  const bytes = readFileSync(path);
  const views = [bytes.toString('utf8'), bytes.toString('utf16le'), bytes.subarray(1).toString('utf16le')];
  for (const view of views) {
    const normalized = normalize(view);
    if (sensitive.test(normalized) || privateValues.some(value => normalized.includes(value))) {
      throw new Error('Possible private identifier in ' + name + '. Package creation stopped.');
    }
  }
  entries.push({name, path, sha256: createHash('sha256').update(bytes).digest('hex')});
}
process.stdout.write(JSON.stringify(entries));
