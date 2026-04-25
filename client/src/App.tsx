import { useRef, useState, useEffect, type RefObject } from 'react';
import { io } from "socket.io-client";
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { Terminal, Save, Cloud, CloudOff } from 'lucide-react';

import './App.css';
import { Sidebar } from './components/Sidebar';
import { rebasePendingOperations } from './collab';
import { generateSafeId, getTrimmedLogs, generateUserCredentials, generateOperationId } from './utils';
import type { User, RemoteCursorData, ServerOp, DocumentState, PendingClientOp } from './types';

const socket = io('ws://localhost:3001', {
  transports: ['websocket'],
  autoConnect: true,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
});

type MonacoEditorInstance = Parameters<OnMount>[0];
type MonacoInstance = Parameters<OnMount>[1];

const { name: USER_NAME, color: USER_COLOR } = generateUserCredentials();

function applySnapshotToEditor(
  editorInstance: MonacoEditorInstance | null,
  content: string,
  isApplyingRemote: RefObject<boolean>
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

function applyRemoteOpToEditor(
  editorInstance: MonacoEditorInstance | null,
  op: ServerOp,
  isApplyingRemote: RefObject<boolean>
) {
  const model = editorInstance?.getModel();
  if (!model) return false;

  const start = model.getPositionAt(op.start);
  const end = model.getPositionAt(op.end);

  isApplyingRemote.current = true;
  try {
    model.applyEdits([{
      range: {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      },
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

  const docIdRef = useRef<string>('main-room');
  const decorationsRef = useRef<Record<string, string[]>>({});
  const isApplyingRemote = useRef<boolean>(false);
  const isHydratedRef = useRef(false);
  const pendingSnapshotRef = useRef<DocumentState | null>(null);
  const queuedRemoteOpsRef = useRef<ServerOp[]>([]);
  const pendingLocalOpsRef = useRef<PendingClientOp[]>([]);
  const serverVersionRef = useRef<number | null>(null);

  const [docId, setDocId] = useState('main-room');
  const [logs, setLogs] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [isHydrated, setIsHydrated] = useState(false);
  const [roomUsers, setRoomUsers] = useState<User[]>([]);

  const [availableDocs, setAvailableDocs] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  const fetchDocuments = async () => {
    try {
      const res = await fetch('http://localhost:3001/documents');
      if (res.ok) {
        const docs = await res.json();
        setAvailableDocs(docs);
      }
    } catch (e) {
      console.error("Failed to fetch documents:", e);
    }
  };


  const deleteDocument = async (idToDelete: string) => {
    if (!confirm(`Are you sure you want to delete document "${idToDelete}"?`)) return;

    try {
      const res = await fetch(`http://localhost:3001/documents/${idToDelete}`, { method: 'DELETE' });
      if (res.ok) {
        setAvailableDocs(prev => prev.filter(d => d !== idToDelete));
        if (idToDelete === docIdRef.current) {
          joinRoom('main-room');
        }
      }
    } catch (e) {
      console.error("Failed to delete document:", e);
    }
  };

  useEffect(() => {
    fetchDocuments();
  }, []);

  const addLog = (msg: string) => setLogs(prev => getTrimmedLogs(msg, prev));
  useEffect(() => {
    docIdRef.current = docId;
  }, [docId]);

  const resetSyncState = () => {
    pendingSnapshotRef.current = null;
    queuedRemoteOpsRef.current = [];
    pendingLocalOpsRef.current = [];
    serverVersionRef.current = null;
    setIsSaving(false);
  };

  const joinRoom = (newRoomId: string) => {
    if (newRoomId === docId) return;
    socket.emit('leave', { docId });

    setDocId(newRoomId);
    setRoomUsers([]);
    setIsHydrated(false);
    isHydratedRef.current = false;
    resetSyncState();

    addLog(`Joining room: ${newRoomId}`);
    socket.emit('join', { docId: newRoomId, userName: USER_NAME, color: USER_COLOR });

    fetchDocuments();
  };

  const removeUserDecorations = (userId: string) => {
    if (editorRef.current && decorationsRef.current[userId]) {
      editorRef.current.deltaDecorations(decorationsRef.current[userId], []);
      delete decorationsRef.current[userId];
      const safeId = generateSafeId(userId);
      const styleTag = document.getElementById(`style-${safeId}`);
      if (styleTag) styleTag.remove();
    }
  };

  const sendNextPendingOp = () => {
    const currentVersion = serverVersionRef.current;
    const nextOp = pendingLocalOpsRef.current[0];

    if (!socket.connected || !isHydratedRef.current || currentVersion === null || !nextOp || nextOp.sent) {
      return;
    }

    nextOp.sent = true;
    setIsSaving(true);
    socket.emit('client-op', {
      docId: nextOp.docId,
      opId: nextOp.opId,
      start: nextOp.start,
      end: nextOp.end,
      text: nextOp.text,
      baseVersion: currentVersion,
    });
  };

  const handleEditorChange = (_value: string | undefined, event?: editor.IModelContentChangedEvent) => {
    if (isApplyingRemote.current || !socket.connected || !isHydrated || !event) return;

    const pendingOps = [...event.changes]
      .sort((left, right) => right.rangeOffset - left.rangeOffset)
      .map<PendingClientOp>(change => ({
        docId: docIdRef.current,
        opId: generateOperationId(),
        start: change.rangeOffset,
        end: change.rangeOffset + change.rangeLength,
        text: change.text,
        sent: false,
      }));

    pendingLocalOpsRef.current = [...pendingLocalOpsRef.current, ...pendingOps];
    sendNextPendingOp();
  };

  const flushQueuedRemoteOps = (editorInstance: MonacoEditorInstance | null) => {
    const currentVersion = serverVersionRef.current;
    if (!editorInstance || currentVersion === null) return;

    const pendingOps = queuedRemoteOpsRef.current
      .filter(op => op.version > currentVersion)
      .sort((left, right) => left.version - right.version);

    queuedRemoteOpsRef.current = [];

    pendingOps.forEach(op => {
      serverVersionRef.current = op.version;

      if (op.userId === socket.id) {
        pendingLocalOpsRef.current = pendingLocalOpsRef.current.filter(localOp => localOp.opId !== op.opId);
      } else {
        const rebased = rebasePendingOperations(pendingLocalOpsRef.current, op);
        pendingLocalOpsRef.current = rebased.pending;

        if (applyRemoteOpToEditor(editorInstance, rebased.remote, isApplyingRemote)) {
          addLog(`Remote edit: ${op.userId.slice(0, 4)}`);
        }
      }
    });

    if (pendingLocalOpsRef.current.length === 0) setIsSaving(false);
    sendNextPendingOp();
  };

  const updateRemoteCursor = (data: RemoteCursorData) => {
    const { userId, selection, name, color } = data;
    if (!editorRef.current || !monacoRef.current || !selection) return;

    const safeId = generateSafeId(userId);
    const newDecorations = [];

    if (selection.startLineNumber !== selection.endLineNumber || selection.startColumn !== selection.endColumn) {
      newDecorations.push({
        range: new monacoRef.current.Range(selection.startLineNumber, selection.startColumn, selection.endLineNumber, selection.endColumn),
        options: { className: `remote-selection-${safeId}` }
      });
    }

    newDecorations.push({
      range: new monacoRef.current.Range(selection.positionLineNumber, selection.positionColumn, selection.positionLineNumber, selection.positionColumn),
      options: {
        className: `remote-cursor-${safeId}`,
        stickiness: monacoRef.current.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
      }
    });

    if (!document.getElementById(`style-${safeId}`)) {
      const style = document.createElement('style');
      style.id = `style-${safeId}`;
      style.innerHTML = `
        .remote-cursor-${safeId} { border-left: 2px solid ${color} !important; margin-left: -1px; position: relative; z-index: 10; }
        .remote-cursor-${safeId}::before { content: '${name}'; position: absolute; top: -22px; left: -2px; background: ${color}; color: white; font-size: 11px; font-weight: 600; padding: 2px 6px; border-radius: 4px; white-space: nowrap; z-index: 1000; opacity: 0; pointer-events: none; transition: opacity 0.15s ease-in-out; box-shadow: 0px 4px 6px rgba(0,0,0,0.3); }
        .remote-cursor-${safeId}:hover::before { opacity: 1; }
        .remote-selection-${safeId} { background-color: ${color}35 !important; border-radius: 2px; }
      `;
      document.head.appendChild(style);
    }

    decorationsRef.current[userId] = editorRef.current.deltaDecorations(decorationsRef.current[userId] || [], newDecorations);
  };

  useEffect(() => {
    const onConnect = () => {
      setIsConnected(true);
      addLog('Connected to server');
      socket.emit('join', { docId: docIdRef.current, userName: USER_NAME, color: USER_COLOR });
    };

    const onDisconnect = () => {
      setIsConnected(false);
      setIsHydrated(false);
      isHydratedRef.current = false;
      resetSyncState();
      addLog('Disconnected from server');
    };

    if (socket.connected) {
      onConnect();
    }

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
      const activeIds = users.map((u: User) => u.id);
      Object.keys(decorationsRef.current).forEach(id => {
        if (!activeIds.includes(id) && id !== socket.id) removeUserDecorations(id);
      });
    });

    socket.on('user-left', (userId: string) => {
      removeUserDecorations(userId);
      addLog(`User left: ${userId.slice(0, 4)}`);
    });

    socket.on('server-update', (op: ServerOp) => {
      setAvailableDocs(prev => {
        if (!prev.includes(docIdRef.current)) {
          return [...prev, docIdRef.current].sort();
        }
        return prev;
      });

      if (serverVersionRef.current === null || !editorRef.current) {
        queuedRemoteOpsRef.current.push(op);
        return;
      }

      if (op.version <= serverVersionRef.current) return;

      serverVersionRef.current = op.version;

      if (op.userId === socket.id) {
        pendingLocalOpsRef.current = pendingLocalOpsRef.current.filter(localOp => localOp.opId !== op.opId);

        if (pendingLocalOpsRef.current.length === 0) setIsSaving(false);

        sendNextPendingOp();
        return;
      }

      const rebased = rebasePendingOperations(pendingLocalOpsRef.current, op);
      pendingLocalOpsRef.current = rebased.pending;

      if (applyRemoteOpToEditor(editorRef.current, rebased.remote, isApplyingRemote)) {
        addLog(`Remote edit: ${op.userId.slice(0, 4)}`);
      }
    });

    socket.on('remote-cursor', updateRemoteCursor);

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('document-state');
      socket.off('users-changed');
      socket.off('user-left');
      socket.off('server-update');
      socket.off('remote-cursor');
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app-container">
      <Sidebar
        isConnected={isConnected}
        roomUsers={roomUsers}
        currentUserId={socket.id || ''}
        logs={logs}
        docId={docId}
        availableDocs={availableDocs}
        onJoinRoom={joinRoom}
        onDeleteDoc={deleteDocument}
      />
      <div className="editor-container">
        <header className="editor-header">
          <div className="project-title">
            <Terminal size={18} className="accent-icon" />
            <span>Code Workspace</span>
          </div>

          <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
            <div className="save-status" style={{ fontSize: '12px', color: '#9ca3af', display: 'flex', alignItems: 'center', gap: '6px' }}>
              {!isConnected ? (
                <><CloudOff size={14} color="#ef4444" /> Offline</>
              ) : isSaving ? (
                <><Save size={14} color="#eab308" /> Saving to DB...</>
              ) : (
                <><Cloud size={14} color="#10b981" /> Saved to DB</>
              )}
            </div>

            <div className="room-badge">
              <span className="badge-dot" style={{ backgroundColor: isConnected ? '#10b981' : '#ef4444' }}></span>
              {docId}
            </div>
          </div>
        </header>
        <div className="editor-wrapper">
          <Editor
            theme="vs-dark"
            language="typescript"
            onMount={(editor, monaco) => {
              editorRef.current = editor;
              monacoRef.current = monaco;
              if (pendingSnapshotRef.current) {
                if (applySnapshotToEditor(editor, pendingSnapshotRef.current.content, isApplyingRemote)) {
                  serverVersionRef.current = pendingSnapshotRef.current.version;
                  setIsHydrated(true);
                  isHydratedRef.current = true;
                  flushQueuedRemoteOps(editor);
                }
              }

              editor.onDidChangeCursorSelection((e) => {
                if (!socket.connected || !isHydratedRef.current) return;
                socket.emit('cursor-move', {
                  docId: docIdRef.current,
                  selection: e.selection,
                  name: USER_NAME,
                  color: USER_COLOR
                });
              });
            }}
            onChange={handleEditorChange}
            options={{
              fontSize: 14,
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              padding: { top: 24, bottom: 24 },
              minimap: { enabled: false },
              smoothScrolling: true,
              cursorSmoothCaretAnimation: 'on',
              formatOnPaste: true,
              readOnly: !isHydrated,
              scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
            }}
          />
        </div>
      </div>
    </div>
  );
}

export default App;