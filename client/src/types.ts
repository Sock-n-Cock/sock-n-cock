export type User = {
  id: string;
  name: string;
  color: string;
};

export type RemoteCursorData = {
  userId: string;
  name: string;
  color: string;
  selection: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
    positionLineNumber: number;
    positionColumn: number;
  };
};

export type ClientOp = {
  docId: string;
  opId: string;
  start: number;
  end: number;
  text: string;
};

export type PendingClientOp = ClientOp & {
  sent: boolean;
};

export type OutgoingClientOp = ClientOp & {
  baseVersion: number;
};

export type ServerOp = OutgoingClientOp & {
  userId: string;
  version: number;
};

export type DocumentState = {
  docId: string;
  content: string;
  version: number;
};
