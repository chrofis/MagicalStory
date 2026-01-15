import { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Log entry captured from server or browser
 */
export interface LogEntry {
  source: 'server' | 'browser';
  type: 'log' | 'warn' | 'error' | 'debug' | 'info';
  text: string;
  timestamp: number;
}

/**
 * Expected log pattern for verification
 */
export interface ExpectedLogPattern {
  pattern: string | RegExp;
  required: boolean;
  source?: 'server' | 'browser' | 'any';
  description?: string;
}

/**
 * Result of log verification
 */
export interface VerificationResult {
  passed: boolean;
  expectedFound: number;
  expectedTotal: number;
  missingRequired: string[];
  unexpectedWarnings: string[];
  unexpectedErrors: string[];
  allLogs: LogEntry[];
  summary: string;
}

/**
 * Predefined log patterns for common operations
 */
export const LOG_PATTERNS = {
  CHARACTER_LOAD: [
    { pattern: '[Characters] GET', required: true, description: 'Character fetch started' },
    { pattern: /Query took \d+ms/, required: true, description: 'DB query completed' },
    { pattern: /Characters count: \d+/, required: true, description: 'Characters loaded' },
  ] as ExpectedLogPattern[],

  CHARACTER_SAVE: [
    { pattern: '[Characters] POST', required: true, description: 'Character save started' },
    { pattern: /Saving \d+ characters/, required: true, description: 'Save count logged' },
    { pattern: 'Database upsert successful', required: true, description: 'DB save completed' },
    { pattern: /Using DB avatars for/, required: false, description: 'Avatar preservation' },
    { pattern: /Preserved data for \d+ characters/, required: false, description: 'Data preserved' },
  ] as ExpectedLogPattern[],

  AVATAR_GENERATION: [
    { pattern: /\[AVATAR\]|\[Avatar\]/, required: true, description: 'Avatar operation' },
    { pattern: /job.*started|generation.*started/i, required: false, description: 'Job started' },
    { pattern: /generated|complete/i, required: false, description: 'Generation complete' },
  ] as ExpectedLogPattern[],
};

/**
 * Log Verifier - Captures and verifies server and browser logs during tests
 */
export class LogVerifier {
  private logs: LogEntry[] = [];
  private expectedPatterns: ExpectedLogPattern[] = [];
  private serverLogPath: string;
  private lastServerLogPosition: number = 0;
  private lastServerLogSize: number = 0;

  constructor(serverLogPath: string = 'logs/server.log') {
    this.serverLogPath = path.resolve(process.cwd(), serverLogPath);
  }

  /**
   * Attach to browser page to capture console output
   */
  attachBrowser(page: Page): void {
    page.on('console', (msg) => {
      const type = msg.type() as LogEntry['type'];
      this.logs.push({
        source: 'browser',
        type: type === 'warning' ? 'warn' : type,
        text: msg.text(),
        timestamp: Date.now(),
      });
    });
  }

  /**
   * Mark current position in server log file
   * Call this before performing an action you want to verify
   */
  markServerLogPosition(): void {
    try {
      if (fs.existsSync(this.serverLogPath)) {
        const stats = fs.statSync(this.serverLogPath);
        this.lastServerLogPosition = stats.size;
        this.lastServerLogSize = stats.size;
      } else {
        this.lastServerLogPosition = 0;
        this.lastServerLogSize = 0;
      }
    } catch {
      this.lastServerLogPosition = 0;
      this.lastServerLogSize = 0;
    }
  }

  /**
   * Read new server logs since last mark
   */
  readNewServerLogs(): LogEntry[] {
    const newLogs: LogEntry[] = [];

    try {
      if (!fs.existsSync(this.serverLogPath)) {
        return newLogs;
      }

      const stats = fs.statSync(this.serverLogPath);
      if (stats.size <= this.lastServerLogPosition) {
        return newLogs;
      }

      // Read only the new content
      const fd = fs.openSync(this.serverLogPath, 'r');
      const buffer = Buffer.alloc(stats.size - this.lastServerLogPosition);
      fs.readSync(fd, buffer, 0, buffer.length, this.lastServerLogPosition);
      fs.closeSync(fd);

      const content = buffer.toString('utf-8');
      const lines = content.split('\n').filter(line => line.trim());

      for (const line of lines) {
        const entry = this.parseLogLine(line);
        if (entry) {
          newLogs.push(entry);
          this.logs.push(entry);
        }
      }

      this.lastServerLogPosition = stats.size;
    } catch (err) {
      console.log(`[LogVerifier] Error reading server log: ${err}`);
    }

    return newLogs;
  }

  /**
   * Parse a log line to determine its type
   */
  private parseLogLine(line: string): LogEntry | null {
    if (!line.trim()) return null;

    let type: LogEntry['type'] = 'log';

    if (line.includes('[ERROR]') || line.includes('Error:')) {
      type = 'error';
    } else if (line.includes('[WARN]') || line.includes('Warning:')) {
      type = 'warn';
    } else if (line.includes('[DEBUG]')) {
      type = 'debug';
    } else if (line.includes('[INFO]')) {
      type = 'info';
    }

    return {
      source: 'server',
      type,
      text: line,
      timestamp: Date.now(),
    };
  }

  /**
   * Define expected log patterns for this test
   */
  expect(patterns: ExpectedLogPattern[]): void {
    this.expectedPatterns = patterns;
  }

  /**
   * Add predefined patterns
   */
  expectPatterns(...patternSets: ExpectedLogPattern[][]): void {
    for (const patterns of patternSets) {
      this.expectedPatterns.push(...patterns);
    }
  }

  /**
   * Verify all expectations against captured logs
   */
  verify(): VerificationResult {
    // Read any remaining server logs
    this.readNewServerLogs();

    const missingRequired: string[] = [];
    let expectedFound = 0;

    // Check each expected pattern
    for (const expected of this.expectedPatterns) {
      const found = this.logs.some(log => {
        // Check source if specified
        if (expected.source && expected.source !== 'any' && log.source !== expected.source) {
          return false;
        }

        // Check pattern
        if (typeof expected.pattern === 'string') {
          return log.text.includes(expected.pattern);
        } else {
          return expected.pattern.test(log.text);
        }
      });

      if (found) {
        expectedFound++;
      } else if (expected.required) {
        const desc = expected.description || String(expected.pattern);
        missingRequired.push(desc);
      }
    }

    // Find unexpected warnings and errors
    const unexpectedWarnings = this.logs
      .filter(log => log.type === 'warn')
      .map(log => log.text);

    const unexpectedErrors = this.logs
      .filter(log => log.type === 'error')
      .map(log => log.text);

    const passed = missingRequired.length === 0 && unexpectedErrors.length === 0;

    const summary = this.buildSummary(expectedFound, missingRequired, unexpectedWarnings, unexpectedErrors);

    return {
      passed,
      expectedFound,
      expectedTotal: this.expectedPatterns.length,
      missingRequired,
      unexpectedWarnings,
      unexpectedErrors,
      allLogs: [...this.logs],
      summary,
    };
  }

  /**
   * Build formatted summary string
   */
  private buildSummary(
    expectedFound: number,
    missingRequired: string[],
    warnings: string[],
    errors: string[]
  ): string {
    const lines: string[] = ['=== LOG VERIFICATION ==='];

    if (expectedFound === this.expectedPatterns.length) {
      lines.push(`✓ Expected logs found: ${expectedFound}/${this.expectedPatterns.length}`);
    } else {
      lines.push(`○ Expected logs found: ${expectedFound}/${this.expectedPatterns.length}`);
    }

    if (warnings.length > 0) {
      lines.push(`⚠️ Warnings detected: ${warnings.length}`);
      for (const w of warnings.slice(0, 5)) {
        lines.push(`  - ${w.substring(0, 100)}${w.length > 100 ? '...' : ''}`);
      }
      if (warnings.length > 5) {
        lines.push(`  ... and ${warnings.length - 5} more`);
      }
    } else {
      lines.push(`✓ No warnings`);
    }

    if (missingRequired.length > 0) {
      lines.push(`❌ Missing required: ${missingRequired.length}`);
      for (const m of missingRequired) {
        lines.push(`  - ${m}`);
      }
    } else {
      lines.push(`✓ All required logs present`);
    }

    if (errors.length > 0) {
      lines.push(`🔴 Errors detected: ${errors.length}`);
      for (const e of errors.slice(0, 5)) {
        lines.push(`  - ${e.substring(0, 100)}${e.length > 100 ? '...' : ''}`);
      }
    } else {
      lines.push(`✓ No errors`);
    }

    lines.push('========================');

    return lines.join('\n');
  }

  /**
   * Print summary to console
   */
  printSummary(): void {
    const result = this.verify();
    console.log(result.summary);
  }

  /**
   * Get all captured logs
   */
  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  /**
   * Get logs filtered by source
   */
  getServerLogs(): LogEntry[] {
    return this.logs.filter(l => l.source === 'server');
  }

  getBrowserLogs(): LogEntry[] {
    return this.logs.filter(l => l.source === 'browser');
  }

  /**
   * Clear captured logs for next test
   */
  clear(): void {
    this.logs = [];
    this.expectedPatterns = [];
  }
}

/**
 * Create a new LogVerifier instance
 */
export function createLogVerifier(serverLogPath?: string): LogVerifier {
  return new LogVerifier(serverLogPath);
}
