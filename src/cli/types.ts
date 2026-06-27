export type CliIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};

export type CliFlags = Record<string, string | true>;
