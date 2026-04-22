import {useRef, useState, useEffect, type RefObject} from 'react';
import { io } from "socket.io-client";
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor, IRange } from 'monaco-editor';
import { Users, Wifi, WifiOff, Activity } from 'lucide-react';

const DOC_ID = 'main-room';
const USER_NAME = `User_${Math.floor(Math.random() * 1000)}`;
const USER_COLOR = `#${Math.floor(Math.random()*16777215).toString(16).padStart(6, '0')}`;

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

type ServerOp = {
  docId: string;
  userId: string;
  text: string;
  range: IRange;
  version: number;
};

type DocumentState = {
  docId: string;
  content: string;
  version: number;
};

function applySnapshotToEditor(
  editorInstance: MonacoEditorInstance | null,
  content: string,
  isApplyingRemote: RefObject<boolean>
) {
  const model = editorInstance?.getModel();
  if (!model) return false;

  // `setValue` triggers Monaco change events, so mark the update as remote to
  // avoid sending the server snapshot back as a new local edit.
  isApplyingRemote.current = true;
  try {
    model.setValue(content);
    return true;
  } finally {
    isApplyingRemote.current = false;
  }
}

function applyRemoteOpToEditor(
  editorInstance: MonacoEditorInstance | null,
  op: ServerOp,
  isApplyingRemote: RefObject<boolean>
) {
  const model = editorInstance?.getModel();
  if (!model) return false;

  // Remote operations also mutate the editor model, so guard against echoing
  // them back to the server through `onChange`.
  isApplyingRemote.current = true;
  try {
    model.applyEdits([{
      range: op.range,
      text: op.text,
      forceMoveMarkers: true
    }]);
    return true;
  } finally {
    isApplyingRemote.current = false;
  }
}

function App() {
  const editorRef = useRef<MonacoEditorInstance>(null);
  const monacoRef = useRef<MonacoInstance>(null);

  const decorationsRef = useRef<Record<string, string[]>>({});
  const isApplyingRemote = useRef<boolean>(false);
  const isHydratedRef = useRef(false);
  const pendingSnapshotRef = useRef<DocumentState | null>(null);
  const queuedRemoteOpsRef = useRef<ServerOp[]>([]);
  const appliedVersionRef = useRef<number | null>(null);

  const [logs, setLogs] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [isHydrated, setIsHydrated] = useState(false);
  const [roomUsers, setRoomUsers] = useState<User[]>([]);

  const addLog = (msg : string) => setLogs(prev => [`${new Date().toLocaleTimeString()} - ${msg}`, ...prev].slice(0, 15));

  const removeUserDecorations = (userId : string) => {
    if (editorRef.current && decorationsRef.current[userId]) {
      editorRef.current.deltaDecorations(decorationsRef.current[userId], []);
      delete decorationsRef.current[userId];

      const safeId = userId.replace(/[^a-z0-9]/gi, '');
      const styleTag = document.getElementById(`style-${safeId}`);
      if (styleTag) styleTag.remove();
    }
  };

  const handleEditorChange = (_value: string | undefined, event?: editor.IModelContentChangedEvent) => {
    if (isApplyingRemote.current || !socket.connected || !isHydrated || !event) return;
    event.changes.forEach(change => {
      socket.emit('client-op', {
        docId: DOC_ID,
        text: change.text,
        range: change.range,
      });
    });
  };

  const flushQueuedRemoteOps = (editorInstance: MonacoEditorInstance | null) => {
    const currentVersion = appliedVersionRef.current;
    if (!editorInstance || currentVersion === null) return;

    // The snapshot establishes our baseline version. Any updates that arrived
    // before hydration finishes are replayed only if they are newer than that.
    const pendingOps = queuedRemoteOpsRef.current
      .filter(op => op.userId !== socket.id && op.version > currentVersion)
      .sort((left, right) => left.version - right.version);

    queuedRemoteOpsRef.current = [];

    pendingOps.forEach(op => {
      if (applyRemoteOpToEditor(editorInstance, op, isApplyingRemote)) {
        appliedVersionRef.current = op.version;
        addLog(`Remote edit: ${op.userId.slice(0, 4)}`);
      }
    });
  };

  const updateRemoteCursor = (data: RemoteCursorData) => {
    const { userId, selection, name, color } = data;

    if (!editorRef.current || !monacoRef.current || !selection) return;

    const safeId = userId.replace(/[^a-z0-9]/gi, '');
    const newDecorations = [];

    if (selection.startLineNumber !== selection.endLineNumber || selection.startColumn !== selection.endColumn) {
      newDecorations.push({
        range: new monacoRef.current.Range(
          selection.startLineNumber,
          selection.startColumn,
          selection.endLineNumber,
          selection.endColumn
        ),
        options: {
          className: `remote-selection-${safeId}`,
        }
      });
    }

    newDecorations.push({
      range: new monacoRef.current.Range(
        selection.positionLineNumber,
        selection.positionColumn,
        selection.positionLineNumber,
        selection.positionColumn
      ),
      options: {
        className: `remote-cursor-${safeId}`,
        stickiness: monacoRef.current.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
      }
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
          box-shadow: 0px 2px 4px rgba(0,0,0,0.2);
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
      newDecorations
    );
  };

  useEffect(() => {
    const onConnect = () => {
      setIsConnected(true);
      setIsHydrated(false);
      isHydratedRef.current = false;
      pendingSnapshotRef.current = null;
      appliedVersionRef.current = null;
      queuedRemoteOpsRef.current = [];
      addLog('Connected to server');
      socket.emit('join', { docId: DOC_ID, userName: USER_NAME, color: USER_COLOR });
    };

    const onDisconnect = () => {
      setIsConnected(false);
      setIsHydrated(false);
      isHydratedRef.current = false;
      pendingSnapshotRef.current = null;
      appliedVersionRef.current = null;
      queuedRemoteOpsRef.current = [];
      addLog('Disconnected from server');
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    socket.on('document-state', (snapshot: DocumentState) => {
      // The snapshot can arrive before Monaco finishes mounting, so keep a copy
      // and hydrate immediately if the editor instance already exists.
      pendingSnapshotRef.current = snapshot;
      appliedVersionRef.current = snapshot.version;

      if (applySnapshotToEditor(editorRef.current, snapshot.content, isApplyingRemote)) {
        setIsHydrated(true);
        isHydratedRef.current = true;
        addLog(`Document synced: ${snapshot.docId}`);
        flushQueuedRemoteOps(editorRef.current);
      }
    });

    socket.on('users-changed', (users : User[]) => {
      setRoomUsers(users);
      const activeIds = users.map((u : User) => u.id);
      Object.keys(decorationsRef.current).forEach(id => {
        if (!activeIds.includes(id) && id !== socket.id) {
          removeUserDecorations(id);
        }
      });
    });

    socket.on('user-left', (userId : string) => {
      removeUserDecorations(userId);
      addLog(`User left: ${userId.slice(0, 4)}`);
    });

    socket.on('server-update', (op: ServerOp) => {
      if (appliedVersionRef.current === null || !editorRef.current) {
        queuedRemoteOpsRef.current.push(op);
        return;
      }

      if (op.version <= appliedVersionRef.current) return;

      appliedVersionRef.current = op.version;

      if (op.userId === socket.id) return;

      if (applyRemoteOpToEditor(editorRef.current, op, isApplyingRemote)) {
        addLog(`Remote edit: ${op.userId.slice(0, 4)}`);
      }
    });

    socket.on('remote-cursor', (data) => {
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
  }, []);

  return (
    <div style={{ display: 'flex', height: '100vh', backgroundColor: '#1e1e1e', color: 'white', overflow: 'hidden' }}>
      <div style={{ width: '260px', borderRight: '1px solid #333', padding: '15px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ marginBottom: '20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Users size={20}/> People
          </h3>
          {isConnected ? <Wifi size={18} color="#4caf50"/> : <WifiOff size={18} color="#f44336"/>}
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {roomUsers.map(u => (
            <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', color: u.id === socket.id ? '#fff' : '#ccc' }}>
              <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: u.color }}></div>
              <span style={{ fontSize: '14px' }}>{u.name} {u.id === socket.id ? '(You)' : ''}</span>
            </div>
          ))}
        </div>
        <div style={{ height: '200px', borderTop: '1px solid #333', paddingTop: '10px' }}>
          <h3 style={{ fontSize: '14px', color: '#888', display: 'flex', alignItems: 'center', gap: '8px' }}><Activity size={16}/> Logs</h3>
          <div style={{ fontSize: '11px', color: '#666', height: '160px', overflowY: 'auto', fontFamily: 'monospace' }}>
            {logs.map((l, i) => <div key={i} style={{ padding: '2px 0' }}>{l}</div>)}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, position: 'relative' }}>
        <Editor
          theme="vs-dark"
          language="javascript"
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            monacoRef.current = monaco;

            // When the editor mounts after the socket handshake, hydrate it from
            // the cached snapshot and then replay any newer queued operations.
            if (pendingSnapshotRef.current) {
              if (applySnapshotToEditor(editor, pendingSnapshotRef.current.content, isApplyingRemote)) {
                appliedVersionRef.current = pendingSnapshotRef.current.version;
                setIsHydrated(true);
                isHydratedRef.current = true;
                flushQueuedRemoteOps(editor);
              }
            }

            editor.onDidChangeCursorSelection((e) => {
              if (!socket.connected || !isHydratedRef.current) return;
              socket.emit('cursor-move', {
                docId: DOC_ID,
                selection: e.selection,
                name: USER_NAME,
                color: USER_COLOR
              });
            });
          }}
          onChange={handleEditorChange}
          options={{
            fontSize: 15,
            padding: { top: 15, bottom: 15 },
            automaticLayout: true,
            cursorSmoothCaretAnimation: 'on',
            // Prevent editing stale local text until the server snapshot arrives.
            readOnly: !isHydrated,
          }}
        />
      </div>
    </div>
  );
}

export default App;
