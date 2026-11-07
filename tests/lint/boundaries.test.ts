// @req NF-011
// レイヤ境界の lint ルールが実際に違反を検出することの確認（違反を意図的に混ぜて落ちること）。
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ overrideConfigFile: 'eslint.config.mjs' });

async function rules(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? 'parse-error');
}

describe('レイヤ境界（違反を検出する）', () => {
  it.each([
    ['domain が node:fs を import', 'src/domain/x.ts', "import fs from 'node:fs'; export const a = fs;"],
    ['domain が fs を import', 'src/domain/x.ts', "import fs from 'fs'; export const a = fs;"],
    ['domain が electron を import', 'src/domain/x.ts', "import { app } from 'electron'; export const a = app;"],
    ['domain が react を import', 'src/domain/x.ts', "import { useState } from 'react'; export const a = useState;"],
    ['domain が main を import', 'src/domain/x.ts', "import { f } from '../main/ipc'; export const a = f;"],
    ['domain が shared を import', 'src/domain/x.ts', "import { f } from '@shared/ipc'; export const a = f;"],
    ['domain が document を使う', 'src/domain/x.ts', 'export const a = document.title;'],
    ['domain が process を使う', 'src/domain/x.ts', 'export const a = process.env;'],
    ['renderer が electron を import', 'src/renderer/x.ts', "import { app } from 'electron'; export const a = app;"],
    ['renderer が node:path を import', 'src/renderer/x.ts', "import path from 'node:path'; export const a = path;"],
    ['renderer が main を import', 'src/renderer/x.ts', "import { f } from '../main/ipc'; export const a = f;"],
    ['main が renderer を import', 'src/main/x.ts', "import { App } from '../renderer/App'; export const a = App;"],
    ['main が react を import', 'src/main/x.ts', "import { useState } from 'react'; export const a = useState;"],
    ['shared が react を import', 'src/shared/x.ts', "import { useState } from 'react'; export const a = useState;"],
    ['shared が node:fs を import', 'src/shared/x.ts', "import fs from 'node:fs'; export const a = fs;"],
    ['preload が renderer を import', 'src/preload/x.ts', "import { App } from '../renderer/App'; export const a = App;"],
    ['viewer が react を import', 'src/viewer/x.ts', "import { useState } from 'react'; export const a = useState;"],
    ['viewer が renderer を import', 'src/viewer/x.ts', "import { App } from '../renderer/App'; export const a = App;"],
  ])('%s → 違反として検出される', async (_name, filePath, code) => {
    const found = await rules(filePath, code);
    expect(found.some((r) => r === 'no-restricted-imports' || r === 'no-restricted-globals')).toBe(true);
  });

  it.each([
    ['domain は純粋なコードを書ける', 'src/domain/x.ts', 'export const add = (a: number, b: number): number => a + b;'],
    ['renderer は shared / domain を import できる', 'src/renderer/x.ts', "import type { Api } from '@shared/ipc'; import { x } from '@domain/y'; export const a = [x, {} as Api];"],
    ['main は electron と node を使える', 'src/main/x.ts', "import { app } from 'electron'; import { join } from 'node:path'; export const a = [app, join];"],
    ['preload は electron を使える', 'src/preload/x.ts', "import { contextBridge } from 'electron'; export const a = contextBridge;"],
    ['shared は domain を import できる', 'src/shared/x.ts', "import { x } from '@domain/y'; export const a = x;"],
  ])('%s → 違反なし', async (_name, filePath, code) => {
    const found = await rules(filePath, code);
    expect(found.filter((r) => r === 'no-restricted-imports' || r === 'no-restricted-globals')).toEqual([]);
  });
});
