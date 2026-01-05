export class SendspinEvent {
  constructor(public readonly type: string) {}
}

export class ClientAddedEvent extends SendspinEvent {
  constructor(public readonly clientId: string) {
    super('client-added');
  }
}

export class ClientRemovedEvent extends SendspinEvent {
  constructor(public readonly clientId: string) {
    super('client-removed');
  }
}
