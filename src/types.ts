/**
 * Types & Schema definitions for dsh-subagent-dispatcher
 */

export interface TaskDispatcherConfig {
  toolName?: string;
  defaultReasoningEffort?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  defaultProvider?: string;
  defaultModel?: string;
  maxRounds?: number;
  maxResultChars?: number;
  autoVerifyFiles?: boolean;
  subagentProvider?: string;
  verificationTimeoutMs?: number;
}

export interface TaskArgs {
  task: string;
  acceptance_criteria?: string;
  verification_command?: string;
  expected_files?: string[];
  model?: string;
  reasoning_effort?: string;
  max_retries?: number;
}

export interface VerificationResult {
  executed: boolean;
  success: boolean;
  exitCode?: number;
  output?: string;
  message: string;
}

export interface FileCheckResult {
  verified: boolean;
  missing: string[];
  details: string[];
}

export interface TaskDeliveryOutput {
  status: 'accepted' | 'rejected' | 'failed';
  summary: string;
  deliverables: string;
  filesModified?: string[];
  verificationResult: string;
  criteriaCheck: string;
  roundsUsed: number;
  tokenSavings: string;
}
