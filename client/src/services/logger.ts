/**
 * Logger service with admin-only verbose logging
 * - Admin users: See all logs (debug, info, warn, error)
 * - Normal users: Only see error logs (prevents reverse engineering)
 */

interface LoggerConfig {
  isAdmin: boolean;
  prefix?: string;
}

let globalConfig: LoggerConfig = {
  isAdmin: false,
  prefix: '🪄',
};

// Style definitions for different log levels
const styles = {
  debug: 'color: #9ca3af; font-weight: normal;',
  info: 'color: #6366f1; font-weight: normal;',
  warn: 'color: #f59e0b; font-weight: bold;',
  error: 'color: #ef4444; font-weight: bold;',
  success: 'color: #22c55e; font-weight: bold;',
};

/**
 * Configure the logger (call on auth state change)
 */
export function configureLogger(config: Partial<LoggerConfig>) {
  globalConfig = { ...globalConfig, ...config };
  if (globalConfig.isAdmin) {
    console.log('%c🔓 Admin logging enabled', styles.success);
  }
}

/**
 * Check if verbose logging is enabled
 */
export function isVerboseLogging(): boolean {
  return globalConfig.isAdmin;
}

/**
 * Debug log - admin only
 */
export function debug(message: string, ...args: unknown[]) {
  if (!globalConfig.isAdmin) return;
  console.log(`%c${globalConfig.prefix} [DEBUG] ${message}`, styles.debug, ...args);
}

/**
 * Info log - admin only
 */
export function info(message: string, ...args: unknown[]) {
  if (!globalConfig.isAdmin) return;
  console.log(`%c${globalConfig.prefix} [INFO] ${message}`, styles.info, ...args);
}

/**
 * Success log - admin only
 */
export function success(message: string, ...args: unknown[]) {
  if (!globalConfig.isAdmin) return;
  console.log(`%c${globalConfig.prefix} ✓ ${message}`, styles.success, ...args);
}

/**
 * Warning log - always shown
 */
export function warn(message: string, ...args: unknown[]) {
  console.warn(`%c${globalConfig.prefix} [WARN] ${message}`, styles.warn, ...args);
}

/**
 * Error log - always shown
 */
export function error(message: string, ...args: unknown[]) {
  console.error(`%c${globalConfig.prefix} [ERROR] ${message}`, styles.error, ...args);
}

/**
 * Group logs - admin only
 */
export function group(label: string) {
  if (!globalConfig.isAdmin) return;
  console.group(`${globalConfig.prefix} ${label}`);
}

export function groupEnd() {
  if (!globalConfig.isAdmin) return;
  console.groupEnd();
}

/**
 * Table log - admin only
 */
export function table(data: unknown) {
  if (!globalConfig.isAdmin) return;
  console.table(data);
}

/**
 * Time measurement - admin only
 */
export function time(label: string) {
  if (!globalConfig.isAdmin) return;
  console.time(`${globalConfig.prefix} ${label}`);
}

export function timeEnd(label: string) {
  if (!globalConfig.isAdmin) return;
  console.timeEnd(`${globalConfig.prefix} ${label}`);
}

// Create namespaced loggers for different modules
export function createLogger(namespace: string) {
  const ns = `[${namespace}]`;
  return {
    debug: (msg: string, ...args: unknown[]) => debug(`${ns} ${msg}`, ...args),
    info: (msg: string, ...args: unknown[]) => info(`${ns} ${msg}`, ...args),
    success: (msg: string, ...args: unknown[]) => success(`${ns} ${msg}`, ...args),
    warn: (msg: string, ...args: unknown[]) => warn(`${ns} ${msg}`, ...args),
    error: (msg: string, ...args: unknown[]) => error(`${ns} ${msg}`, ...args),
    group: (label: string) => group(`${ns} ${label}`),
    groupEnd,
    table,
    time: (label: string) => time(`${ns} ${label}`),
    timeEnd: (label: string) => timeEnd(`${ns} ${label}`),
  };
}

// Default export for convenience
const logger = {
  configure: configureLogger,
  isVerbose: isVerboseLogging,
  debug,
  info,
  success,
  warn,
  error,
  group,
  groupEnd,
  table,
  time,
  timeEnd,
  create: createLogger,
};

export default logger;
