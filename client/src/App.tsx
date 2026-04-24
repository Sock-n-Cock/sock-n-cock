import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { Activity, Users, Wifi, WifiOff } from 'lucide-react';
import { io } from 'socket.io-client';

import {
  type LocalTextOperation,
  type ServerTextOperation,
  transformTextOperation,
} from './operations';

const DOC_ID = 'main-room';
const USER_NAME = `User_${Math.floor(Math.random() * 1000)}`;
const USER_COLOR = `#${Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')}`;

const socket = io('ws://localhost:3001', {
  transports: ['websocket'],
  autoConnect: true,
  reconnection: true,
});

type MonacoEditorInstance = Parameters<OnMount>[0];
type MonacoInstance = Parameters<OnMount>[1];

type User = {
  id: string;
  name: string;
  color: string;
};

type RemoteCursorData = {
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

type DocumentState = {
  docId: string;
  content: string;
  version: number;
};

function applySnapshotToEditor(
  editorInstance: MonacoEditorInstance | null,
  content: string,
  isApplyingRemote: RefObject<boolean>,
) {
  const model = editorInstance?.getModel();
  if (!model) return false;

  isApplyingRemote.current = true;
  try {
    model.setValue(content);
    return true;
  } finally {
    isApplyingRemote.current = false;
  }
}

function applyTextOpToEditor(
  editorInstance: MonacoEditorInstance | null,
  operation: Pick<ServerTextOperation | LocalTextOperation, 'start' | 'end' | 'text'>,
  isApplyingRemote: RefObject<boolean>,
) {
  const model = editorInstance?.getModel();
  if (!model) return false;

  const startPosition = model.getPositionAt(operation.start);
  const endPosition = model.getPositionAt(operation.end);

  isApplyingRemote.current = true;
  try {
    model.applyEdits([
      {
        range: {
          startLineNumber: startPosition.lineNumber,
          startColumn: startPosition.column,
          endLineNumber: endPosition.lineNumber,
          endColumn: endPosition.column,
        },
        text: operation.text,
        forceMoveMarkers: true,
      },
    ]);
    return true;
  } finally {
    isApplyingRemote.current = false;
  }
}

function App() {
  const editorRef = useRef<MonacoEditorInstance>(null);
  const monacoRef = useRef<MonacoInstance>(null);

  const decorationsRef = useRef<Record<string, string[]>>({});
  const isApplyingRemote = useRef(false);
  const isHydratedRef = useRef(false);
  const pendingSnapshotRef = useRef<DocumentState | null>(null);
  const queuedRemoteOpsRef = useRef<ServerTextOperation[]>([]);
  const pendingLocalOpsRef = useRef<LocalTextOperation[]>([]);
  const serverVersionRef = useRef<number | null>(null);
  const nextOpIdRef = useRef(0);

  const [logs, setLogs] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [isHydrated, setIsHydrated] = useState(false);
  const [roomUsers, setRoomUsers] = useState<User[]>([]);

  const addLog = useCallback(
    (message: string) =>
      setLogs((prev) => [`${new Date().toLocaleTimeString()} - ${message}`, ...prev].slice(0, 15)),
    [],
  );

  const removeUserDecorations = (userId: string) => {
    if (editorRef.current && decorationsRef.current[userId]) {
      editorRef.current.deltaDecorations(decorationsRef.current[userId], []);
      delete decorationsRef.current[userId];

      const safeId = userId.replace(/[^a-z0-9]/gi, '');
      const styleTag = document.getElementById(`style-${safeId}`);
      if (styleTag) styleTag.remove();
    }
  };

  const processServerOp = useCallback((
    operation: ServerTextOperation,
    editorInstance: MonacoEditorInstance | null,
  ) => {
    const serverVersion = serverVersionRef.current;
    if (!editorInstance || serverVersion === null || operation.version <= serverVersion) return;

    if (operation.userId === socket.id) {
      pendingLocalOpsRef.current = pendingLocalOpsRef.current.filter(
        (pendingOperation) => pendingOperation.opId !== operation.opId,
      );
      serverVersionRef.current = operation.version;
      return;
    }

    let rebasedRemoteOperation = operation;
    pendingLocalOpsRef.current.forEach((pendingOperation) => {
      rebasedRemoteOperation = transformTextOperation(
        rebasedRemoteOperation,
        pendingOperation,
        'before',
      );
    });

    if (applyTextOpToEditor(editorInstance, rebasedRemoteOperation, isApplyingRemote)) {
      pendingLocalOpsRef.current = pendingLocalOpsRef.current.map((pendingOperation) =>
        transformTextOperation(pendingOperation, operation, 'after'),
      );
      serverVersionRef.current = operation.version;
      addLog(`Remote edit: ${operation.userId.slice(0, 4)}`);
    }
  }, [addLog]);

  const flushQueuedRemoteOps = useCallback((editorInstance: MonacoEditorInstance | null) => {
    if (!editorInstance || serverVersionRef.current === null) return;

    const queuedOps = [...queuedRemoteOpsRef.current].sort((left, right) => left.version - right.version);
    queuedRemoteOpsRef.current = [];
    queuedOps.forEach((operation) => {
      processServerOp(operation, editorInstance);
    });
  }, [processServerOp]);

  const handleEditorChange = (_value: string | undefined, event?: editor.IModelContentChangedEvent) => {
    if (isApplyingRemote.current || !socket.connected || !isHydrated || !event) return;

    const baseVersion = (serverVersionRef.current ?? 0) + pendingLocalOpsRef.current.length;

    // Monaco reports multi-cursor changes from the end of the document, so
    // preserving the event order keeps later queued ops aligned with the model.
    event.changes.forEach((change, index) => {
      const operation: LocalTextOperation = {
        docId: DOC_ID,
        opId: `${socket.id ?? 'offline'}-${nextOpIdRef.current}`,
        text: change.text,
        start: change.rangeOffset,
        end: change.rangeOffset + change.rangeLength,
        baseVersion: baseVersion + index,
      };

      nextOpIdRef.current += 1;
      pendingLocalOpsRef.current.push(operation);
      socket.emit('client-op', operation);
    });
  };

  const updateRemoteCursor = (data: RemoteCursorData) => {
    const { userId, selection, name, color } = data;

    if (!editorRef.current || !monacoRef.current || !selection) return;

    const safeId = userId.replace(/[^a-z0-9]/gi, '');
    const newDecorations = [];

    if (
      selection.startLineNumber !== selection.endLineNumber ||
      selection.startColumn !== selection.endColumn
    ) {
      newDecorations.push({
        range: new monacoRef.current.Range(
          selection.startLineNumber,
          selection.startColumn,
          selection.endLineNumber,
          selection.endColumn,
        ),
        options: {
          className: `remote-selection-${safeId}`,
        },
      });
    }

    newDecorations.push({
      range: new monacoRef.current.Range(
        selection.positionLineNumber,
        selection.positionColumn,
        selection.positionLineNumber,
        selection.positionColumn,
      ),
      options: {
        className: `remote-cursor-${safeId}`,
        stickiness: monacoRef.current.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    });

    if (!document.getElementById(`style-${safeId}`)) {
      const style = document.createElement('style');
      style.id = `style-${safeId}`;
      style.innerHTML = `
        .remote-cursor-${safeId} {
          border-left: 2px solid ${color} !important;
          margin-left: -1px;
          position: relative;
          z-index: 10;
          border-right: 4px solid transparent;
        }

        .remote-cursor-${safeId}::before {
          content: '${name}';
          position: absolute;
          top: -20px;
          left: -2px;
          background: ${color};
          color: white;
          font-size: 11px;
          padding: 2px 6px;
          border-radius: 4px;
          white-space: nowrap;
          z-index: 1000;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.2s ease-in-out;
          font-family: sans-serif;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        }

        .remote-cursor-${safeId}:hover::before {
          opacity: 1;
        }

        .remote-selection-${safeId} {
          background-color: ${color}40 !important;
        }
      `;
      document.head.appendChild(style);
    }

    decorationsRef.current[userId] = editorRef.current.deltaDecorations(
      decorationsRef.current[userId] || [],
      newDecorations,
    );
  };

  useEffect(() => {
    const onConnect = () => {
      setIsConnected(true);
      setIsHydrated(false);
      isHydratedRef.current = false;
      pendingSnapshotRef.current = null;
      queuedRemoteOpsRef.current = [];
      pendingLocalOpsRef.current = [];
      serverVersionRef.current = null;
      addLog('Connected to server');
      socket.emit('join', { docId: DOC_ID, userName: USER_NAME, color: USER_COLOR });
    };

    const onDisconnect = () => {
      setIsConnected(false);
      setIsHydrated(false);
      isHydratedRef.current = false;
      pendingSnapshotRef.current = null;
      queuedRemoteOpsRef.current = [];
      pendingLocalOpsRef.current = [];
      serverVersionRef.current = null;
      addLog('Disconnected from server');
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    socket.on('document-state', (snapshot: DocumentState) => {
      pendingSnapshotRef.current = snapshot;
      serverVersionRef.current = snapshot.version;

      if (applySnapshotToEditor(editorRef.current, snapshot.content, isApplyingRemote)) {
        setIsHydrated(true);
        isHydratedRef.current = true;
        addLog(`Document synced: ${snapshot.docId}`);
        flushQueuedRemoteOps(editorRef.current);
      }
    });

    socket.on('users-changed', (users: User[]) => {
      setRoomUsers(users);
      const activeIds = users.map((user) => user.id);
      Object.keys(decorationsRef.current).forEach((id) => {
        if (!activeIds.includes(id) && id !== socket.id) {
          removeUserDecorations(id);
        }
      });
    });

    socket.on('user-left', (userId: string) => {
      removeUserDecorations(userId);
      addLog(`User left: ${userId.slice(0, 4)}`);
    });

    socket.on('server-update', (operation: ServerTextOperation) => {
      if (serverVersionRef.current === null || !editorRef.current) {
        queuedRemoteOpsRef.current.push(operation);
        return;
      }

      processServerOp(operation, editorRef.current);
    });

    socket.on('remote-cursor', (data: RemoteCursorData) => {
      updateRemoteCursor(data);
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('document-state');
      socket.off('users-changed');
      socket.off('user-left');
      socket.off('server-update');
      socket.off('remote-cursor');
    };
  }, [addLog, flushQueuedRemoteOps, processServerOp]);

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        backgroundColor: '#1e1e1e',
        color: 'white',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: '260px',
          borderRight: '1px solid #333',
          padding: '15px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            marginBottom: '20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <h3 style={{ margin: 0, fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Users size={20} /> People
          </h3>
          {isConnected ? <Wifi size={18} color="#4caf50" /> : <WifiOff size={18} color="#f44336" />}
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {roomUsers.map((user) => (
            <div
              key={user.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '6px 0',
                color: user.id === socket.id ? '#fff' : '#ccc',
              }}
            >
              <div
                style={{
                  width: '10px',
                  height: '10px',
                  borderRadius: '50%',
                  backgroundColor: user.color,
                }}
              />
              <span style={{ fontSize: '14px' }}>
                {user.name} {user.id === socket.id ? '(You)' : ''}
              </span>
            </div>
          ))}
        </div>

        <div style={{ height: '200px', borderTop: '1px solid #333', paddingTop: '10px' }}>
          <h3 style={{ fontSize: '14px', color: '#888', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Activity size={16} /> Logs
          </h3>
          <div
            style={{
              fontSize: '11px',
              color: '#666',
              height: '160px',
              overflowY: 'auto',
              fontFamily: 'monospace',
            }}
          >
            {logs.map((logEntry, index) => (
              <div key={index} style={{ padding: '2px 0' }}>
                {logEntry}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, position: 'relative' }}>
        <Editor
          theme="vs-dark"
          language="javascript"
          onMount={(editorInstance, monacoInstance) => {
            editorRef.current = editorInstance;
            monacoRef.current = monacoInstance;

            if (pendingSnapshotRef.current) {
              if (
                applySnapshotToEditor(
                  editorInstance,
                  pendingSnapshotRef.current.content,
                  isApplyingRemote,
                )
              ) {
                serverVersionRef.current = pendingSnapshotRef.current.version;
                setIsHydrated(true);
                isHydratedRef.current = true;
                flushQueuedRemoteOps(editorInstance);
              }
            }

            editorInstance.onDidChangeCursorSelection((selectionEvent) => {
              if (!socket.connected || !isHydratedRef.current) return;
              socket.emit('cursor-move', {
                docId: DOC_ID,
                selection: selectionEvent.selection,
                name: USER_NAME,
                color: USER_COLOR,
              });
            });
          }}
          onChange={handleEditorChange}
          options={{
            fontSize: 15,
            padding: { top: 15, bottom: 15 },
            automaticLayout: true,
            cursorSmoothCaretAnimation: 'on',
            readOnly: !isHydrated,
          }}
        />
      </div>
    </div>
  );
}

export default App;
