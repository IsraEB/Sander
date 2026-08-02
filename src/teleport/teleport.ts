import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GitignoreRule {
  pattern: string;
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  hasSlash: boolean;
}

export function parseGitignore(content: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  for (const rawLine of content.split('\n')) {
    let line = rawLine.replace(/\r$/, '');
    line = line.replace(/\\#/g, '#').replace(/\\!/g, '!').replace(/\\\\/g, '\\');
    if (line.trim() === '') {
      continue;
    }
    if (line.startsWith('#')) {
      continue;
    }
    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    } else if (line.startsWith('\\!')) {
      line = line.slice(1);
    }
    if (line.trim() === '') {
      continue;
    }
    const dirOnly = line.endsWith('/');
    if (dirOnly) {
      line = line.slice(0, -1);
    }
    const anchored = line.startsWith('/');
    if (anchored) {
      line = line.slice(1);
    }
    if (line === '') {
      continue;
    }
    const hasSlash = line.includes('/');
    rules.push({ pattern: line, negated, dirOnly, anchored, hasSlash });
  }
  return rules;
}

export function loadGitignore(root: string): GitignoreRule[] {
  const file = path.join(root, '.gitignore');
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    return parseGitignore(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i++;
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        source += '\\[';
      } else {
        source += pattern.slice(i, end + 1);
        i = end;
      }
    } else {
      source += ch.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

export function matchesRule(relativePath: string, rule: GitignoreRule): boolean {
  const p = relativePath.replace(/^\.\//, '').replace(/\/+$/, '');
  if (p === '' || p === '.') {
    return false;
  }
  const isDir = relativePath !== p || relativePath.endsWith('/');
  const segments = p.split('/');
  const regex = globToRegExp(rule.pattern);

  const accept = (candidate: string, candidateIsDir: boolean): boolean => {
    if (!regex.test(candidate)) {
      return false;
    }
    if (!rule.dirOnly) {
      return true;
    }
    return candidateIsDir;
  };

  // Patterns with a slash are anchored to the gitignore's root: they match the
  // full relative path, or a directory prefix of it (which hides everything
  // below that directory).
  if (rule.anchored || rule.hasSlash) {
    for (let i = segments.length; i >= 1; i--) {
      const candidate = segments.slice(0, i).join('/');
      if (accept(candidate, i < segments.length ? true : isDir)) {
        return true;
      }
    }
    return false;
  }

  // Patterns without a slash match a single path segment (a basename) at any
  // depth. A matching directory hides everything below it.
  for (let i = 0; i < segments.length; i++) {
    if (!regex.test(segments[i])) {
      continue;
    }
    const segmentIsDir = i < segments.length - 1;
    if (!rule.dirOnly || segmentIsDir || isDir) {
      return true;
    }
  }
  return false;
}

export function isIgnored(relativePath: string, rules: GitignoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (matchesRule(relativePath, rule)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

export function filterGitignored(root: string, relativePaths: string[]): string[] {
  const rules = loadGitignore(root);
  return relativePaths.filter((p) => !isIgnored(p, rules));
}

function walkRelative(dir: string, rel: string, push: (relPath: string) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === '.git') {
      continue;
    }
    const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      walkRelative(path.join(dir, entry.name), relPath, push);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      push(relPath);
    }
  }
}

export function listFilesRelative(root: string): string[] {
  const out: string[] = [];
  walkRelative(root, '', (relPath) => out.push(relPath));
  return out.sort();
}

export function listProjectFiles(root: string): string[] {
  const rules = loadGitignore(root);
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === '.git') {
        continue;
      }
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (isIgnored(`${relPath}/`, rules)) {
          continue;
        }
        walk(path.join(dir, entry.name), relPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (!isIgnored(relPath, rules)) {
          out.push(relPath);
        }
      }
    }
  };
  walk(root, '');
  return out.sort();
}
