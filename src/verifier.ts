/**
 * Automated Acceptance & Verification Engine
 */

import { exec as nodeExec } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';
import type { VerificationResult, FileCheckResult } from './types.js';

const execAsync = promisify(nodeExec);

export function truncateText(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) return text || '';
  return text.slice(0, maxChars - 20) + '\n... [输出截断]';
}

export async function runVerificationCommand(
  command?: string,
  cwd?: string,
  timeoutMs = 30000
): Promise<VerificationResult> {
  if (!command || typeof command !== 'string' || !command.trim()) {
    return { executed: false, success: true, message: '未指定验证命令' };
  }

  try {
    const { stdout, stderr } = await execAsync(command.trim(), {
      cwd: cwd || process.cwd(),
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    const output = (stdout + '\n' + stderr).trim();
    return {
      executed: true,
      success: true,
      exitCode: 0,
      output: truncateText(output || '(命令执行成功，无额外输出)', 2048),
      message: `验证命令 \`${command}\` 执行成功 (退出码 0)`,
    };
  } catch (error: any) {
    const output = ((error.stdout || '') + '\n' + (error.stderr || '') + '\n' + error.message).trim();
    return {
      executed: true,
      success: false,
      exitCode: error.code || 1,
      output: truncateText(output, 2048),
      message: `验证命令 \`${command}\` 执行失败 (退出码 ${error.code || 1})`,
    };
  }
}

export function verifyExpectedFiles(files?: string[], cwd?: string): FileCheckResult {
  if (!Array.isArray(files) || files.length === 0) {
    return { verified: true, missing: [], details: [] };
  }

  const missing: string[] = [];
  const details: string[] = [];

  for (const relativePath of files) {
    const fullPath = pathResolve(cwd || process.cwd(), relativePath);
    if (!existsSync(fullPath)) {
      missing.push(relativePath);
      details.push(`❌ \`${relativePath}\`: 文件不存在`);
    } else {
      const stat = statSync(fullPath);
      if (stat.size === 0) {
        details.push(`⚠️ \`${relativePath}\`: 文件存在但内容为空 (0 字节)`);
      } else {
        details.push(`✅ \`${relativePath}\`: 正常存在 (${stat.size} 字节)`);
      }
    }
  }

  return {
    verified: missing.length === 0,
    missing,
    details,
  };
}
