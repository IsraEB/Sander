import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// agentbox hardcodes this path (see dist/lib/first-run.ts setupMarkerPath).
export function agentboxSetupMarkerPath(): string {
  return path.join(os.homedir(), '.agentbox', 'setup-complete.json');
}
export function isAgentboxSetupDone(markerPath: string): boolean {
  return fs.existsSync(markerPath);
}
// Mirrors agentbox's markSetupComplete() shape: { version: 1, completedAt, provider }.
export function writeAgentboxSetupMarker(markerPath: string, provider = 'docker'): void {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify({ version: 1, completedAt: new Date().toISOString(), provider }, null, 2) + '\n');
}
