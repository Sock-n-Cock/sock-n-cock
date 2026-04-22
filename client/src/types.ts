import type { IRange } from "monaco-editor";

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

export type ServerOp = {
  docId: string;
  userId: string;
  text: string;
  range: IRange;
  version: number;
};

export type DocumentState = {
  docId: string;
  content: string;
  version: number;
};