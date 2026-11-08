/**
 * The root resolver's tests.
 *
 * The server is registered once, globally, and used in many projects. So
 * "which project is this call about?" is answered per call, and the order
 * of the answers is part of the contract. These tests pin that order
 * down.
 *
 * The environment variables are saved and restored around each test, so
 * one test's `ORCHESTRATOR_ROOT` cannot leak into the next.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOARD_DIR,
  BOARD_FILE,
  MAX_UPWARD_LEVELS,
  POLICY_FILE,
  fallbackDefaultBranch,
  findBoardUpwards,
  projectName,
  resolveCall,
  resolveRoot,
} from '../root.js';
import { cleanup, makeRepo, tempDir } from './helpers.js';

const ENV_KEYS = ['ORCHESTRATOR_ROOT', 'ORCHESTRATOR_BOARD', 'ORCHESTRATOR_POLICY', 'ORCHESTRATOR_DEFAULT_BRANCH'];

/** Run a body with a clean environment, then restore what was there. */
function withEnv<T>(overrides: Record<string, string | undefined>, body: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  try {
    for (const key of ENV_KEYS) {
      if (overrides[key] === undefined) delete process.env[key];
      else process.env[key] = overrides[key];
    }
    return body();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('an explicit project path wins over everything', () => {
  withEnv({ ORCHESTRATOR_ROOT: '/nowhere' }, () => {
    const result = resolveRoot('/tmp');
    assert.equal(result.source, 'project');
    assert.equal(result.root, '/tmp');
  });
});

test('an explicit project path is resolved against the working directory', () => {
  withEnv({}, () => {
    const result = resolveRoot('sub/dir');
    assert.equal(result.source, 'project');
    assert.equal(result.root, join(process.cwd(), 'sub/dir'));
  });
});

test('an empty project path falls through to the environment', () => {
  const dir = tempDir();
  try {
    withEnv({ ORCHESTRATOR_ROOT: dir }, () => {
      const result = resolveRoot('   ');
      assert.equal(result.source, 'env');
      assert.equal(result.root, dir);
    });
  } finally {
    cleanup(dir);
  }
});

test('ORCHESTRATOR_ROOT is used when there is no explicit path', () => {
  const dir = tempDir();
  try {
    withEnv({ ORCHESTRATOR_ROOT: dir }, () => {
      const result = resolveRoot();
      assert.equal(result.source, 'env');
      assert.equal(result.root, dir);
    });
  } finally {
    cleanup(dir);
  }
});

test('an ORCHESTRATOR_ROOT that does not exist is reported', () => {
  withEnv({ ORCHESTRATOR_ROOT: '/definitely/not/here' }, () => {
    const result = resolveRoot();
    assert.equal(result.source, 'env');
    assert.match(result.note ?? '', /does not exist/);
  });
});

test('ORCHESTRATOR_BOARD is used when there is no root', () => {
  const dir = tempDir();
  try {
    const board = join(dir, '.orchestrator', 'board.json');
    withEnv({ ORCHESTRATOR_BOARD: board }, () => {
      const result = resolveRoot();
      assert.equal(result.source, 'board');
      // The board lives in <root>/.orchestrator/, so the root is one level
      // above its directory.
      assert.equal(result.root, dir);
    });
  } finally {
    cleanup(dir);
  }
});

test('the working directory is the last resort', () => {
  const dir = tempDir();
  try {
    withEnv({}, () => {
      const result = resolveRoot();
      assert.ok(['cwd', 'repo'].includes(result.source));
    });
  } finally {
    cleanup(dir);
  }
});

test('the board is looked for at the root', () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, BOARD_DIR), { recursive: true });
    writeFileSync(join(dir, BOARD_DIR, BOARD_FILE), '{}', 'utf-8');
    const found = findBoardUpwards(dir);
    assert.equal(found, join(dir, BOARD_DIR, BOARD_FILE));
  } finally {
    cleanup(dir);
  }
});

test('the board is looked for upwards from a subdirectory', () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, BOARD_DIR), { recursive: true });
    writeFileSync(join(dir, BOARD_DIR, BOARD_FILE), '{}', 'utf-8');
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
    const found = findBoardUpwards(join(dir, 'src', 'deep'));
    assert.equal(found, join(dir, BOARD_DIR, BOARD_FILE));
  } finally {
    cleanup(dir);
  }
});

test('a board directly in the directory is also found', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, BOARD_FILE), '{}', 'utf-8');
    assert.equal(findBoardUpwards(dir), join(dir, BOARD_FILE));
  } finally {
    cleanup(dir);
  }
});

test('the upward search does not wander too far', () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, BOARD_DIR), { recursive: true });
    writeFileSync(join(dir, BOARD_DIR, BOARD_FILE), '{}', 'utf-8');
    const deep = join(dir, ...Array.from({ length: MAX_UPWARD_LEVELS + 2 }, (_, i) => `d${i}`));
    mkdirSync(deep, { recursive: true });
    assert.equal(findBoardUpwards(deep), null);
  } finally {
    cleanup(dir);
  }
});

test('the upward search returns null when there is no board', () => {
  const dir = tempDir();
  try {
    assert.equal(findBoardUpwards(dir), null);
  } finally {
    cleanup(dir);
  }
});

test('the expected board path is returned when there is no board yet', () => {
  const dir = tempDir();
  try {
    withEnv({ ORCHESTRATOR_ROOT: dir }, () => {
      const res = resolveCall();
      assert.equal(res.boardPath, join(dir, BOARD_DIR, BOARD_FILE));
    });
  } finally {
    cleanup(dir);
  }
});

test('the policy path sits beside the board', () => {
  const dir = tempDir();
  try {
    withEnv({ ORCHESTRATOR_ROOT: dir }, () => {
      const res = resolveCall();
      assert.equal(res.policyPath, join(dir, BOARD_DIR, POLICY_FILE));
    });
  } finally {
    cleanup(dir);
  }
});

test('ORCHESTRATOR_POLICY overrides the policy path', () => {
  const dir = tempDir();
  try {
    withEnv({ ORCHESTRATOR_ROOT: dir, ORCHESTRATOR_POLICY: join(dir, 'custom.json') }, () => {
      const res = resolveCall();
      assert.equal(res.policyPath, join(dir, 'custom.json'));
    });
  } finally {
    cleanup(dir);
  }
});

test('a project inside a repository resolves the repository root', () => {
  const dir = tempDir();
  try {
    makeRepo(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    withEnv({ ORCHESTRATOR_ROOT: join(dir, 'src') }, () => {
      const res = resolveCall();
      assert.equal(res.repoRoot, dir);
    });
  } finally {
    cleanup(dir);
  }
});

test('a project outside a repository has no repository root', () => {
  const dir = tempDir();
  try {
    withEnv({ ORCHESTRATOR_ROOT: dir }, () => {
      const res = resolveCall();
      assert.equal(res.repoRoot, null);
      assert.match(res.note ?? '', /not inside a git repository/);
    });
  } finally {
    cleanup(dir);
  }
});

test('the project name is the directory name', () => {
  const dir = tempDir();
  try {
    assert.equal(projectName(dir), dir.split('/').pop());
  } finally {
    cleanup(dir);
  }
});

test('the fallback default branch is main', () => {
  withEnv({}, () => {
    assert.equal(fallbackDefaultBranch(), 'main');
  });
});

test('the fallback default branch can be overridden', () => {
  withEnv({ ORCHESTRATOR_DEFAULT_BRANCH: 'trunk' }, () => {
    assert.equal(fallbackDefaultBranch(), 'trunk');
  });
});

test('a board that exists is returned as the board path', () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, BOARD_DIR), { recursive: true });
    const path = join(dir, BOARD_DIR, BOARD_FILE);
    writeFileSync(path, '{}', 'utf-8');
    withEnv({ ORCHESTRATOR_ROOT: dir }, () => {
      const res = resolveCall();
      assert.equal(res.boardPath, path);
      assert.ok(existsSync(res.boardPath!));
    });
  } finally {
    cleanup(dir);
  }
});
