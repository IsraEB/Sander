import { describe, expect, it } from 'vitest';
import { backupRelPath, planSync, summarizePlan } from './plan';
import type { SyncHashes, SyncManifest, SyncPlan, SyncStatus } from './plan';

describe('planSync', () => {
  it('plans a path dirty only on the host as a copy host→box', () => {
    const plan = planSync({ 'a.txt': 'M' }, {});
    expect(plan).toEqual([{ kind: 'copy-host-to-box', relPath: 'a.txt' }]);
  });

  it('plans a path dirty only on the box as a pull box→host', () => {
    const plan = planSync({}, { 'a.txt': 'M' });
    expect(plan).toEqual([{ kind: 'pull-box-to-host', relPath: 'a.txt' }]);
  });

  it('plans a path dirty on both sides with identical content as a no-op', () => {
    const hashes: SyncHashes = { 'a.txt': { host: 'abc', box: 'abc' } };
    expect(planSync({ 'a.txt': 'M' }, { 'a.txt': 'M' }, hashes)).toEqual([{ kind: 'noop', relPath: 'a.txt' }]);
  });

  it('plans a path dirty on both sides with different content as a conflict that backs up the host version and pulls', () => {
    const hashes: SyncHashes = { 'a.txt': { host: 'abc', box: 'def' } };
    expect(planSync({ 'a.txt': 'M' }, { 'a.txt': 'M' }, hashes)).toEqual([
      { kind: 'conflict', relPath: 'a.txt', backup: '.sander/a.txt.sander-host', apply: 'pull' },
    ]);
  });

  it('treats a missing content hash for a both-dirty path as a conflict', () => {
    const plan = planSync({ 'a.txt': 'M' }, { 'a.txt': 'M' });
    expect(plan).toEqual([{ kind: 'conflict', relPath: 'a.txt', backup: '.sander/a.txt.sander-host', apply: 'pull' }]);
  });

  it('propagates a deletion on the host to the box', () => {
    expect(planSync({ 'a.txt': 'D' }, {})).toEqual([{ kind: 'delete-in-box', relPath: 'a.txt' }]);
  });

  it('propagates a deletion on the box to the host', () => {
    expect(planSync({}, { 'a.txt': 'D' })).toEqual([{ kind: 'delete-in-host', relPath: 'a.txt' }]);
  });

  it('plans a deletion on both sides as a no-op', () => {
    expect(planSync({ 'a.txt': 'D' }, { 'a.txt': 'D' })).toEqual([{ kind: 'noop', relPath: 'a.txt' }]);
  });

  it('plans a host deletion vs a box modification as a conflict that pulls the box version', () => {
    expect(planSync({ 'a.txt': 'D' }, { 'a.txt': 'M' })).toEqual([
      { kind: 'conflict', relPath: 'a.txt', backup: '.sander/a.txt.sander-host', apply: 'pull' },
    ]);
  });

  it('plans a host modification vs a box deletion as a conflict that backs up and applies the deletion', () => {
    expect(planSync({ 'a.txt': 'M' }, { 'a.txt': 'D' })).toEqual([
      { kind: 'conflict', relPath: 'a.txt', backup: '.sander/a.txt.sander-host', apply: 'delete' },
    ]);
  });

  it('plans untracked paths like modified ones', () => {
    expect(planSync({ 'new.txt': '??' }, {})).toEqual([{ kind: 'copy-host-to-box', relPath: 'new.txt' }]);
    expect(planSync({}, { 'new.txt': '??' })).toEqual([{ kind: 'pull-box-to-host', relPath: 'new.txt' }]);
  });

  it('plans untracked on both sides like modified on both sides', () => {
    const same: SyncHashes = { 'new.txt': { host: 'abc', box: 'abc' } };
    expect(planSync({ 'new.txt': '??' }, { 'new.txt': '??' }, same)).toEqual([{ kind: 'noop', relPath: 'new.txt' }]);
    const different: SyncHashes = { 'new.txt': { host: 'abc', box: 'def' } };
    expect(planSync({ 'new.txt': '??' }, { 'new.txt': '??' }, different)).toEqual([
      { kind: 'conflict', relPath: 'new.txt', backup: '.sander/new.txt.sander-host', apply: 'pull' },
    ]);
  });

  it('plans an untracked path present on both sides without hashes as a conflict', () => {
    expect(planSync({ 'new.txt': '??' }, { 'new.txt': '??' })).toEqual([
      { kind: 'conflict', relPath: 'new.txt', backup: '.sander/new.txt.sander-host', apply: 'pull' },
    ]);
  });

  it('treats any non-deleted status as a modification for robustness', () => {
    const plan = planSync({ 'staged.txt': 'A' as SyncStatus }, {});
    expect(plan).toEqual([{ kind: 'copy-host-to-box', relPath: 'staged.txt' }]);
  });

  it('orders the plan by relative path', () => {
    const plan = planSync({ 'z.txt': 'M', 'a.txt': 'M', 'm/n.txt': 'M' }, {});
    expect(plan.map((op) => op.relPath)).toEqual(['a.txt', 'm/n.txt', 'z.txt']);
  });

  it('returns an empty plan when both manifests are empty', () => {
    expect(planSync({}, {})).toEqual([]);
  });

  it('is pure: the same inputs produce the same plan without mutating them', () => {
    const host: SyncManifest = { 'a.txt': 'M', 'b.txt': 'D' };
    const box: SyncManifest = { 'a.txt': 'M', 'c.txt': '??' };
    const hashes: SyncHashes = { 'a.txt': { host: 'abc', box: 'def' } };
    const first = planSync(host, box, hashes);
    const second = planSync(host, box, hashes);
    expect(second).toEqual(first);
    expect(host).toEqual({ 'a.txt': 'M', 'b.txt': 'D' });
    expect(box).toEqual({ 'a.txt': 'M', 'c.txt': '??' });
    expect(hashes).toEqual({ 'a.txt': { host: 'abc', box: 'def' } });
  });

  it('mixes every op kind into one deterministic ordered plan', () => {
    const host: SyncManifest = { 'copy.txt': 'M', 'host-d.txt': 'D', 'c.txt': 'M', 'e.txt': 'M' };
    const box: SyncManifest = { 'pull.txt': 'M', 'box-d.txt': 'D', 'c.txt': 'M', 'e.txt': 'M' };
    const hashes: SyncHashes = { 'c.txt': { host: 'x', box: 'y' }, 'e.txt': { host: 'x', box: 'x' } };
    const plan = planSync(host, box, hashes);
    expect(plan).toEqual([
      { kind: 'delete-in-host', relPath: 'box-d.txt' },
      { kind: 'conflict', relPath: 'c.txt', backup: '.sander/c.txt.sander-host', apply: 'pull' },
      { kind: 'copy-host-to-box', relPath: 'copy.txt' },
      { kind: 'noop', relPath: 'e.txt' },
      { kind: 'delete-in-box', relPath: 'host-d.txt' },
      { kind: 'pull-box-to-host', relPath: 'pull.txt' },
    ]);
  });
});

describe('backupRelPath', () => {
  it('derives the backup path under .sander with the side suffix', () => {
    expect(backupRelPath('src/main.ts', 'host')).toBe('.sander/src/main.ts.sander-host');
    expect(backupRelPath('notes.md', 'box')).toBe('.sander/notes.md.sander-box');
  });
});

describe('summarizePlan', () => {
  it('counts box→host copies, host→box copies and conflicts', () => {
    const plan: SyncPlan = [
      { kind: 'copy-host-to-box', relPath: 'a' },
      { kind: 'pull-box-to-host', relPath: 'b' },
      { kind: 'conflict', relPath: 'c', backup: '.sander/c.sander-host', apply: 'pull' },
      { kind: 'conflict', relPath: 'd', backup: '.sander/d.sander-host', apply: 'delete' },
      { kind: 'delete-in-box', relPath: 'e' },
      { kind: 'delete-in-host', relPath: 'f' },
      { kind: 'noop', relPath: 'g' },
    ];
    expect(summarizePlan(plan)).toEqual({ boxToHost: 1, hostToBox: 1, conflicts: 2 });
  });

  it('counts zero for an empty plan', () => {
    expect(summarizePlan([])).toEqual({ boxToHost: 0, hostToBox: 0, conflicts: 0 });
  });
});
