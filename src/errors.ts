export type TestkitErrorCode =
  | "PUBLIC_BIND_REFUSED"
  | "SEED_INVALID"
  | "SEED_UNKNOWN_USER"
  | "SEED_UNKNOWN_ORGANIZATION"
  | "SEED_NO_MEMBERSHIP"
  | "INVALID_DURATION"
  | "INVALID_REQUEST"
  | "EMULATOR_UNREACHABLE";

export class TestkitError extends Error {
  readonly code: TestkitErrorCode;
  readonly details: string[];

  constructor(code: TestkitErrorCode, message: string, details: string[] = []) {
    super(details.length > 0 ? `${message}\n\n${details.map((d) => `  - ${d}`).join("\n")}` : message);
    this.name = "TestkitError";
    this.code = code;
    this.details = details;
  }

  toString(): string {
    return `${this.code}\n\n${this.message}`;
  }
}
