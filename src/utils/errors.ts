export class MobileBuildMCPError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MobileBuildMCPError';
    Object.setPrototypeOf(this, MobileBuildMCPError.prototype);
  }
}

export class ValidationError extends MobileBuildMCPError {
  constructor(
    message: string,
    public paramName?: string,
  ) {
    super(message);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class SystemError extends MobileBuildMCPError {
  constructor(
    message: string,
    public originalError?: Error,
  ) {
    super(message);
    this.name = 'SystemError';
    Object.setPrototypeOf(this, SystemError.prototype);
  }
}

export class ConfigurationError extends MobileBuildMCPError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
    Object.setPrototypeOf(this, ConfigurationError.prototype);
  }
}

export class SimulatorError extends MobileBuildMCPError {
  constructor(
    message: string,
    public simulatorName?: string,
    public simulatorId?: string,
  ) {
    super(message);
    this.name = 'SimulatorError';
    Object.setPrototypeOf(this, SimulatorError.prototype);
  }
}

export class AxeError extends MobileBuildMCPError {
  constructor(
    message: string,
    public command?: string,
    public axeOutput?: string,
    public simulatorId?: string,
  ) {
    super(message);
    this.name = 'AxeError';
    Object.setPrototypeOf(this, AxeError.prototype);
  }
}

export class DependencyError extends ConfigurationError {
  constructor(
    message: string,
    public details?: string,
  ) {
    super(message);
    this.name = 'DependencyError';
    Object.setPrototypeOf(this, DependencyError.prototype);
  }
}

/**
 * Normalize an unknown thrown value to a string message.
 */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
