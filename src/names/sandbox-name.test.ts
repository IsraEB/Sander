import { describe, expect, it } from 'vitest';
import {
  DOCKER_NAME_MAX,
  GIT_NAME_MAX,
  containerNameForSandbox,
  dockerContainerName,
  isDockerSafeContainerName,
  isValidGitBranchName,
} from './sandbox-name';

describe('isValidGitBranchName', () => {
  it('accepts docker-safe names', () => {
    for (const name of ['demo', 'a_b.c', 'foo-1', 'release-v1.2.3']) {
      expect(isValidGitBranchName(name)).toBe(true);
    }
  });

  it('accepts git-valid names that docker forbids', () => {
    for (const name of ['feature/asd-jshdia', 'foo@bar', 'a{b}c', 'release/v1.2.3', 'tést', '_lead', 'a.b']) {
      expect(isValidGitBranchName(name)).toBe(true);
    }
  });

  it('rejects empty and over-long names', () => {
    expect(isValidGitBranchName('')).toBe(false);
    expect(isValidGitBranchName('a'.repeat(GIT_NAME_MAX))).toBe(true);
    expect(isValidGitBranchName('a'.repeat(GIT_NAME_MAX + 1))).toBe(false);
  });

  it('rejects names git branch shorthand forbids', () => {
    for (const name of ['-lead', 'a b', 'a..b', '@{x', '@', 'a/', '/a', 'a//b', 'a.', '.hidden', 'foo.lock']) {
      expect(isValidGitBranchName(name)).toBe(false);
    }
  });

  it('rejects control characters and git-special characters', () => {
    for (const name of ['a\x00b', 'a\x1Fb', 'a\x7Fb', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b']) {
      expect(isValidGitBranchName(name)).toBe(false);
    }
  });
});

describe('isDockerSafeContainerName', () => {
  it('accepts docker-safe names', () => {
    for (const name of ['demo', 'a_b.c-d']) {
      expect(isDockerSafeContainerName(name)).toBe(true);
    }
  });

  it('rejects docker-invalid names', () => {
    for (const name of ['feature/asd-jshdia', 'foo@bar', 'tést', '-foo', '_foo', '.foo']) {
      expect(isDockerSafeContainerName(name)).toBe(false);
    }
  });

  it('rejects over-long names', () => {
    expect(isDockerSafeContainerName('a'.repeat(DOCKER_NAME_MAX))).toBe(true);
    expect(isDockerSafeContainerName('a'.repeat(DOCKER_NAME_MAX + 1))).toBe(false);
  });
});

function strippedHash(name: string): string {
  const match = /^(.*)-([0-9a-f]{8})$/.exec(name);
  expect(match).not.toBeNull();
  return match ? match[1] : name;
}

describe('containerNameForSandbox', () => {
  it('is the identity for docker-safe ids', () => {
    for (const id of ['demo', 'a_b.c-d']) {
      expect(containerNameForSandbox(id)).toBe(id);
    }
  });

  it('maps every docker-invalid-but-git-valid character to a dash deterministically', () => {
    const cases: Array<[string, string]> = [
      ['feature/asd-jshdia', 'feature-asd-jshdia'],
      ['foo@bar', 'foo-bar'],
      ['a{b}c', 'a-b-c'],
      ['release+v1.2.3', 'release-v1.2.3'],
      ['tést', 't-st'],
      ['héllo', 'h-llo'],
      ['a/b@c{d}e(f)g+h=i,j;k$l#m%n&o"p\'q<r>s!t|u', 'a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u'],
    ];
    for (const [id, expectedBase] of cases) {
      expect(strippedHash(containerNameForSandbox(id))).toBe(expectedBase);
    }
  });

  it('maps every git-valid-but-docker-invalid character, including ` and ]', () => {
    // Exhaustive sweep over printable ASCII: every single character that git
    // accepts but docker's charset rejects must become a dash deterministically.
    for (let i = 0x21; i <= 0x7e; i++) {
      const ch = String.fromCharCode(i);
      const probe = `a${ch}b`;
      if (!isValidGitBranchName(probe) || isDockerSafeContainerName(probe)) {
        continue;
      }
      expect(isDockerSafeContainerName(probe)).toBe(false);
      expect(strippedHash(containerNameForSandbox(probe))).toBe('a-b');
      expect(containerNameForSandbox(probe)).toBe(containerNameForSandbox(probe));
    }
    // Non-ASCII (Unicode) characters are git-valid but docker-invalid as well.
    for (const ch of ['é', 'ñ', 'λ', '中']) {
      const probe = `a${ch}b`;
      expect(isValidGitBranchName(probe)).toBe(true);
      expect(isDockerSafeContainerName(probe)).toBe(false);
      expect(strippedHash(containerNameForSandbox(probe))).toBe('a-b');
    }
  });

  it('guarantees a leading alphanumeric character', () => {
    expect(strippedHash(containerNameForSandbox('_leading'))).toBe('sander-_leading');
    expect(strippedHash(containerNameForSandbox('.hidden'))).toBe('sander-.hidden');
  });

  it('is stable across calls for the same id', () => {
    const id = 'feature/asd-jshdia';
    expect(containerNameForSandbox(id)).toBe(containerNameForSandbox(id));
  });

  it('keeps distinct ids distinct even when the base collides', () => {
    expect(containerNameForSandbox('foo/bar')).not.toBe(containerNameForSandbox('foo-bar'));
  });

  it('keeps the mapped name within the docker cap', () => {
    const long = `${'a'.repeat(GIT_NAME_MAX)}/b`;
    const mapped = containerNameForSandbox(long);
    expect(mapped.length).toBeLessThanOrEqual(DOCKER_NAME_MAX);
    expect(isDockerSafeContainerName(mapped)).toBe(true);
  });
});

describe('dockerContainerName', () => {
  it('prefixes the agentbox box name with agentbox-', () => {
    expect(dockerContainerName('x')).toBe('agentbox-x');
    expect(dockerContainerName('feature-asd-jshdia-01234567')).toBe('agentbox-feature-asd-jshdia-01234567');
  });
});
