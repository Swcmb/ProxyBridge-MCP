// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — 结构化错误定义

export interface ErrorResult {
  code: string
  message: string
  fieldPath: string | null
  hint: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  warnings: WarningResult[]
}

export interface ValidationError {
  code: string
  message: string
  fieldPath: string | null
}

export interface WarningResult {
  code: string
  message: string
  fieldPath: string | null
}

// 阻断级错误码（工具级抛错）
export const TOOL_ERRORS = {
  ENV_CLI_NOT_FOUND: 'ENV_CLI_NOT_FOUND',
  ENV_CLI_NOT_EXECUTABLE: 'ENV_CLI_NOT_EXECUTABLE',
  ENV_CORE_DLL_MISSING: 'ENV_CORE_DLL_MISSING',
  ENV_ADMIN_CHECK_FAILED: 'ENV_ADMIN_CHECK_FAILED',
  ENV_NOT_ADMIN: 'ENV_NOT_ADMIN',
  ALREADY_RUNNING: 'ALREADY_RUNNING',
  CLI_START_FAILED: 'CLI_START_FAILED',
  NOT_RUNNING: 'NOT_RUNNING',
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
  PROFILE_PARSE_ERROR: 'PROFILE_PARSE_ERROR',
  PROFILE_DIR_UNREADABLE: 'PROFILE_DIR_UNREADABLE',
  PROFILE_FILE_EXISTS: 'PROFILE_FILE_EXISTS',
  PROFILE_WRITE_FAILED: 'PROFILE_WRITE_FAILED',
  PROFILE_PATH_OUT_OF_BASE: 'PROFILE_PATH_OUT_OF_BASE',
  PROXY_TIMEOUT_INVALID: 'PROXY_TIMEOUT_INVALID',
  TEST_PROXY_PORT_INVALID: 'TEST_PROXY_PORT_INVALID',
} as const

// 校验级阻断错误码（进 errors[]）
export const VALIDATION_ERRORS = {
  PROFILE_SCHEMA_INVALID: 'PROFILE_SCHEMA_INVALID',
  PROFILE_UNKNOWN_FIELD: 'PROFILE_UNKNOWN_FIELD',
  PROFILE_VERSION_UNSUPPORTED: 'PROFILE_VERSION_UNSUPPORTED',
  PROXY_LIMIT_EXCEEDED: 'PROXY_LIMIT_EXCEEDED',
  PROXY_LIST_EMPTY: 'PROXY_LIST_EMPTY',
  PROXY_ID_DUPLICATE: 'PROXY_ID_DUPLICATE',
  PROXY_TYPE_INVALID: 'PROXY_TYPE_INVALID',
  PROXY_PORT_INVALID: 'PROXY_PORT_INVALID',
  RULE_LIMIT_EXCEEDED: 'RULE_LIMIT_EXCEEDED',
  RULE_PROCESS_EMPTY: 'RULE_PROCESS_EMPTY',
  RULE_ACTION_INVALID: 'RULE_ACTION_INVALID',
  RULE_PROTOCOL_INVALID: 'RULE_PROTOCOL_INVALID',
  RULE_PROXY_REF_MISSING: 'RULE_PROXY_REF_MISSING',
  PROFILE_HOST_PATTERN_INVALID: 'PROFILE_HOST_PATTERN_INVALID',
  PROFILE_PORT_PATTERN_INVALID: 'PROFILE_PORT_PATTERN_INVALID',
} as const

// 警告级错误码（进 warnings[]）
export const VALIDATION_WARNINGS = {
  RULE_SHADOWED: 'RULE_SHADOWED',
  RULE_OVERRIDDEN_BY_FORCED_DIRECT: 'RULE_OVERRIDDEN_BY_FORCED_DIRECT',
  RULE_UDP_REQUIRES_SOCKS5: 'RULE_UDP_REQUIRES_SOCKS5',
  RULE_PROXY_REF_ON_NON_PROXY: 'RULE_PROXY_REF_ON_NON_PROXY',
  PROFILE_UNKNOWN_FIELD_NESTED: 'PROFILE_UNKNOWN_FIELD',
} as const

export function toolError(
  code: keyof typeof TOOL_ERRORS,
  message: string,
  hint: string,
  fieldPath: string | null = null
): ErrorResult {
  return { code, message, fieldPath, hint }
}

export function validationError(
  code: keyof typeof VALIDATION_ERRORS,
  message: string,
  fieldPath: string | null = null
): ValidationError {
  return { code, message, fieldPath }
}

export function warningResult(
  code: keyof typeof VALIDATION_WARNINGS,
  message: string,
  fieldPath: string | null = null
): WarningResult {
  return { code, message, fieldPath }
}
