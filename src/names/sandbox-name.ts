import { createHash } from 'node:crypto';

export const GIT_NAME_MAX = 180;
export const DOCKER_NAME_MAX = 200;

export function isValidGitBranchName(name: string): boolean {
  if (name.length === 0 || name.length > GIT_NAME_MAX) return false;
  if (name.startsWith('-')) return false;
  if (/[\x00-\x1F\x7F ]/.test(name)) return false;
  if (/[~^:?*[\\]/.test(name)) return false;
  if (name.includes('..') || name.includes('@{')) return false;
  if (name === '@') return false;
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return false;
  if (name.endsWith('.')) return false;
  if (name.split('/').some((c) => c.startsWith('.') || c.endsWith('.lock'))) return false;
  return true;
}

export function isDockerSafeContainerName(name: string): boolean {
  return name.length <= DOCKER_NAME_MAX && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name);
}

export function containerNameForSandbox(id: string): string {
  if (isDockerSafeContainerName(id)) {
    return id;
  }
  const base = id.replace(/[^a-zA-Z0-9_.-]/g, '-');
  const fixed = /^[a-zA-Z0-9]/.test(base) ? base : `sander-${base}`;
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 8);
  return `${fixed}-${hash}`;
}

export function dockerContainerName(boxName: string): string {
  return `agentbox-${boxName}`;
}
