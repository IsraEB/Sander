import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  filterGitignored,
  isIgnored,
  listFilesRelative,
  listProjectFiles,
  parseGitignore,
} from './teleport';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sander-teleport-test-'));
}

describe('parseGitignore', () => {
  it('parses comments, blanks, and negation', () => {
    const rules = parseGitignore('# comment\n\nnode_modules/\n!keep.log\n/anchored\n');
    expect(rules).toHaveLength(3);
    expect(rules[0]).toMatchObject({ pattern: 'node_modules', dirOnly: true, negated: false });
    expect(rules[1]).toMatchObject({ pattern: 'keep.log', negated: true });
    expect(rules[2]).toMatchObject({ pattern: 'anchored', anchored: true });
  });
});

describe('isIgnored', () => {
  const rules = parseGitignore('node_modules/\n*.log\n/build/\n!important.log\nsecret.txt');

  it('ignores files under a dir-only pattern', () => {
    expect(isIgnored('node_modules/dep.txt', rules)).toBe(true);
    expect(isIgnored('a/b/node_modules/dep.txt', rules)).toBe(true);
    expect(isIgnored('src/main.js', rules)).toBe(false);
  });

  it('matches glob patterns at any depth', () => {
    expect(isIgnored('x.log', rules)).toBe(true);
    expect(isIgnored('a/b/x.log', rules)).toBe(true);
  });

  it('anchored patterns match only at the root', () => {
    expect(isIgnored('build/out.js', rules)).toBe(true);
    expect(isIgnored('a/build/out.js', rules)).toBe(false);
  });

  it('applies negation with last-match-wins', () => {
    expect(isIgnored('important.log', rules)).toBe(false);
    expect(isIgnored('other.log', rules)).toBe(true);
  });

  it('matches plain file patterns at any depth', () => {
    expect(isIgnored('nested/secret.txt', rules)).toBe(true);
  });
});

describe('listProjectFiles', () => {
  it('returns gitignore-aware files and always skips .git', () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n*.log\n');
    fs.writeFileSync(path.join(root, 'README.md'), 'hi');
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'code');
    fs.writeFileSync(path.join(root, 'src', 'nested', 'helper.ts'), 'code');
    fs.writeFileSync(path.join(root, 'src', 'trace.log'), 'log');
    fs.writeFileSync(path.join(root, 'node_modules', 'dep.txt'), 'heavy');
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref');

    const files = listProjectFiles(root);
    expect(files).toEqual(['.gitignore', 'README.md', 'src/main.ts', 'src/nested/helper.ts']);
  });

  it('includes everything when there is no .gitignore', () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'b');
    const files = listProjectFiles(root);
    expect(files).toEqual(['a.txt', 'sub/b.txt']);
  });
});

describe('filterGitignored', () => {
  it('filters a candidate set by the project .gitignore', () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, '.gitignore'), '*.json\nsecrets/\n');
    const candidates = ['opencode.json', 'command/custom.md', 'secrets/token', 'README.md'];
    expect(filterGitignored(root, candidates)).toEqual(['command/custom.md', 'README.md']);
  });
});

describe('listFilesRelative', () => {
  it('lists all files recursively without any filtering', () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'x'), 'x');
    fs.writeFileSync(path.join(root, 'a', 'b', 'y'), 'y');
    expect(listFilesRelative(root)).toEqual(['a/b/y', 'a/x']);
  });
});
