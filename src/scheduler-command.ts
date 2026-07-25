export type SchedulerCommandKind = 'run-now' | 'reschedule' | 'backfill' | 'pin-sync';

export interface SchedulerCommand {
  sequence: number;
  kind: SchedulerCommandKind;
  requestedAt: number;
  mappingId?: string;
}

export interface SchedulerCommandState {
  sequence: number;
  commands: SchedulerCommand[];
}

export function createSchedulerCommandState(): SchedulerCommandState {
  return { sequence: 0, commands: [] };
}

export function issueSchedulerCommand(
  state: SchedulerCommandState,
  kind: SchedulerCommandKind,
  options: { mappingId?: string; now?: number } = {},
): SchedulerCommand {
  const command: SchedulerCommand = {
    sequence: state.sequence + 1,
    kind,
    requestedAt: options.now ?? Date.now(),
    ...(options.mappingId ? { mappingId: options.mappingId } : {}),
  };
  state.sequence = command.sequence;
  state.commands.push(command);
  if (state.commands.length > 256) {
    state.commands.splice(0, state.commands.length - 256);
  }
  return command;
}

export function getSchedulerCommandsSince(state: SchedulerCommandState, sequence: number): SchedulerCommand[] {
  return state.commands.filter((command) => command.sequence > sequence);
}

export function schedulerCommandRequestsSweep(command: SchedulerCommand): boolean {
  return command.kind === 'run-now';
}
