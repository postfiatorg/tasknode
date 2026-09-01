import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Check, ChevronDown, ChevronRight, Drama, FileText, Lightbulb, ListPlus, MoreHorizontal, Network, Paperclip, Plus, Search, Sparkles, Wand2, X } from "lucide-react";
import { requestEventStream, requestJson } from "../../api";
import { byteSize, createPastedTextAttachment, formatFileSize, mimeTypeFromFilename, promptForAttachments, readFileAsDataUrl, textFromAttachment } from "../../chat-attachments";
import { AgentMessage, AssistantMessage, AttachmentTray, UserMessage } from "./ChatMessages.jsx";
import { IChingSetupDialog } from "./IChingSetupDialog.jsx";
import { ComposerSendButton } from "./ComposerSendButton.jsx";
import { appendAssistantDelta, chatTitleFromPrompt, createErrorAssistantTurn, createPendingAssistantTurn, createRecentPlaceholderThread, createUserTurn, formatElapsedSeconds, newClientConversationId, newClientCorrelationId, normalizeChatMessage, normalizeChatMessages, replaceTurnById, titleFromTurns, updatePendingAssistantProgress } from "./chat-turns";
import { chatSurfaceDisplayState } from "./chat-ui-state.js";
import { ModelOption, ShareModal, formatModeLabel } from "./AppChatDialogs.jsx";
import { chatComposerStatus } from "./chat-surface-state.js";
import { applyContextEditProposal, CONTEXT_EDIT_MODE, CONTEXT_EDIT_PLACEHOLDER, patchContextEditProposalTurn, rejectContextEditProposal } from "../context/context-edit-client";
import { CONTEXT_REWRITE_MODE, CONTEXT_REWRITE_PLACEHOLDER, createContextRewriteJob } from "../context/context-rewrite-client";
import { useContextRewritePolling } from "../context/use-context-rewrite-polling.js";
import { DEEP_RESEARCH_MODE, DEEP_RESEARCH_PLACEHOLDER, createDeepResearchJob } from "./deep-research-client.js";
import { useDeepResearchPolling } from "./use-deep-research-polling.js";
import { ToolMenuRow } from "../shell/ShellControls";
import { publishTaskRequest } from "../tasks/task-request-actions.js";
import { evaluateTaskRequestUnlockPolicy } from "../tasks/task-request-unlock-policy.js";
import { CHAT_MODALITIES, CHAT_PERSONAS, DEFAULT_CHAT_PERSONA, chatPersonaDefinition, chatPersonaIsModality, normalizeChatPersona } from "../../../shared/chat-personas.js";
import { CHAT_ATTACHMENT_ACCEPT, CHAT_ATTACHMENT_MAX_BYTES, CHAT_ATTACHMENT_MAX_COUNT, CHAT_COMPOSER_MAX_HEIGHT, CHAT_PASTE_ATTACHMENT_THRESHOLD, CHAT_PERSONA_ICONS, CHAT_SCROLL_BOTTOM_THRESHOLD, CHAT_STARTER_PROMPTS, HIVE_CHAT_PLACEHOLDER, HIVE_CHAT_TITLE, TASK_REQUEST_CANONICAL_TEXT, TASK_REQUEST_PLACEHOLDER, clientHistoryPayloadFromTurns, serializeChatAttachments } from "../../app/app-shell-shared.jsx";

export function ChatSurface({
  accountId = "", activeChat, chat, chatResetKey, chatSelectionKey, chatShareRequestKey,
  contextRefinePending = false, contextRewritePending = false, directOffchainTaskLifecycle = false, linkedWalletAddress = "", onActiveChatChange, onChatSettled,
  onContextRefineHandled, onContextRewriteHandled, onWalletUnlock, usage,
  walletSecret = null, walletUnlockPending = false, walletVault = {},
}) {
  const signedOut = !accountId;
  const activeRequestAbortRef = useRef(null);
  const allModes = chat?.modes || [];
  const modes = signedOut ? allModes.filter((mode) => mode.label === "Help") : allModes;
  const messages = useMemo(() => chat?.seedMessages || [], [chat?.seedMessages]);
  const defaultMode = signedOut
    ? modes.find((mode) => mode.label === "Help" && mode.enabled)?.label || "Help"
    : chat?.defaultMode || "Instant";
  useEffect(() => () => {
    activeRequestAbortRef.current?.abort();
    activeRequestAbortRef.current = null;
  }, []);
  const isHiveChat = activeChat?.kind === "hive";
  const [turns, setTurns] = useState(() => normalizeChatMessages(messages));
  // The user's chosen chat mode is a preference, not view state. It must
  // survive navigation and remounts instead of snapping back to the server
  // default. Stored per account; only an explicit picker click writes it.
  const chatModeStorageKey = accountId ? `tasknode.chat.mode.${accountId}` : "";
  const storedChatMode = (() => {
    if (!chatModeStorageKey) return "";
    try {
      const value = window.localStorage?.getItem(chatModeStorageKey) || "";
      return modes.some((mode) => mode.label === value && mode.enabled) ? value : "";
    } catch {
      return "";
    }
  })();
  const [selectedMode, setSelectedMode] = useState(storedChatMode || defaultMode);
  const chatPersonaStorageKey = accountId ? `tasknode.chat.persona.${accountId}` : "";
  const storedChatPersona = (() => {
    if (!chatPersonaStorageKey) return "";
    try {
      return normalizeChatPersona(window.localStorage?.getItem(chatPersonaStorageKey) || "", { fallback: "" });
    } catch {
      return "";
    }
  })();
  const [selectedPersona, setSelectedPersona] = useState(storedChatPersona || DEFAULT_CHAT_PERSONA);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [personaMenuOpen, setPersonaMenuOpen] = useState(false);
  const [modalityMenuOpen, setModalityMenuOpen] = useState(false);
  const [taskRequestMode, setTaskRequestMode] = useState(false);
  const [contextEditMode, setContextEditMode] = useState(false);
  const [contextRewriteMode, setContextRewriteMode] = useState(false);
  const [deepResearchMode, setDeepResearchMode] = useState(false);
  const [contextEditSavingId, setContextEditSavingId] = useState("");
  const [input, setInput] = useState("");
  const [sendMessage, setSendMessage] = useState("");
  const [actualUsage, setActualUsage] = useState(null);
  const [statusTone, setStatusTone] = useState("muted");
  const [sending, setSending] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const [composerDragActive, setComposerDragActive] = useState(false);
  const [draftConversationId, setDraftConversationId] = useState(() => newClientConversationId());
  const [editingMsg, setEditingMsg] = useState(null);
  const [editDraft, setEditDraft] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [iChingSetupOpen, setIChingSetupOpen] = useState(false);
  const [iChingProfileSummary, setIChingProfileSummary] = useState(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  useEffect(() => {
    if (signedOut || selectedPersona !== "i-ching") return undefined;
    let cancelled = false;
    requestJson("/api/i-ching/profile")
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) throw new Error(result.body?.message || `I Ching setup returned HTTP ${result.status}.`);
        if (!result.body?.exists) {
          setIChingProfileSummary(null);
          setIChingSetupOpen(true);
        } else {
          setIChingProfileSummary(result.body.profile || {});
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setSelectedPersona(DEFAULT_CHAT_PERSONA);
        if (chatPersonaStorageKey) {
          try {
            window.localStorage?.setItem(chatPersonaStorageKey, DEFAULT_CHAT_PERSONA);
          } catch {
            /* storage unavailable: selection still applies for this session */
          }
        }
        setSendMessage(error?.message || "I Ching setup is unavailable.");
        setStatusTone("error");
      });
    return () => {
      cancelled = true;
    };
  }, [chatPersonaStorageKey, selectedPersona, signedOut]);
  function persistChatPersona(personaId) {
    setSelectedPersona(personaId);
    if (!chatPersonaStorageKey) return;
    try {
      window.localStorage?.setItem(chatPersonaStorageKey, personaId);
    } catch {
      /* storage unavailable: selection still applies for this session */
    }
  }
  function activateChatModality(modality) {
    persistChatPersona(modality.id);
    setTaskRequestMode(false);
    setContextEditMode(false);
    setContextRewriteMode(false);
    setDeepResearchMode(false);
    setModalityMenuOpen(false);
    setPlusMenuOpen(false);
    setSendMessage("");
    setStatusTone("muted");
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }
  const taskRequestUnlockPolicy = evaluateTaskRequestUnlockPolicy({
    accountId,
    directOffchain: directOffchainTaskLifecycle,
    linkedWalletAddress,
    walletSecret,
    walletVault,
    unlockPending: walletUnlockPending,
  });
  const walletReady = taskRequestUnlockPolicy.allowed;
  const plusRef = useRef(null);
  const modelRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const composerDragDepthRef = useRef(0);
  const messageListRef = useRef(null);
  const resetSeenRef = useRef(0);
  const shareSeenRef = useRef(chatShareRequestKey);
  const clearedChatRef = useRef(false);
  const scrollNearBottomRef = useRef(true);
  const { pollContextRewriteJob, replaceContextRewriteAssistant } = useContextRewritePolling({
    onChatSettled, setSendMessage, setStatusTone, setTurns,
  });
  const { pollDeepResearchJob } = useDeepResearchPolling({
    onChatSettled, setSendMessage, setStatusTone, setTurns, turns,
  });
  const updateScrollBottomVisibility = useCallback(() => {
    const list = messageListRef.current;
    if (!list) {
      setShowScrollBottom(false);
      scrollNearBottomRef.current = true;
      return;
    }
    const overflow = list.scrollHeight - list.clientHeight > CHAT_SCROLL_BOTTOM_THRESHOLD;
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    const nearBottom = !overflow || distanceFromBottom <= CHAT_SCROLL_BOTTOM_THRESHOLD;
    scrollNearBottomRef.current = nearBottom;
    setShowScrollBottom(overflow && !nearBottom);
  }, []);
  const loadConversationHistory = useCallback(async (
    conversationId,
    { showLoading = true, shouldApply = () => true } = {}
  ) => {
    const normalizedConversationId = String(conversationId || "").trim();
    if (!normalizedConversationId) return [];
    const historyPath = chat?.historyPath || "/api/chat/history";
    if (showLoading && shouldApply()) {
      setTurns([]);
      setHistoryLoading(true);
    }
    try {
      const result = await requestJson(`${historyPath}?conversationId=${encodeURIComponent(normalizedConversationId)}`);
      if (!shouldApply()) return [];
      if (!result.ok) {
        throw new Error(result.body?.message || `History returned HTTP ${result.status}.`);
      }
      const hydrated = normalizeChatMessages(result.body?.messages || []);
      setTurns(hydrated);
      if (showLoading) setHistoryLoading(false);
      return hydrated;
    } catch (error) {
      if (showLoading && shouldApply()) setHistoryLoading(false);
      throw error;
    }
  }, [chat?.historyPath]);
  useEffect(() => {
    // Re-apply the server default only when the user has no stored
    // preference; a remount or app-state refresh must not clobber a choice.
    if (storedChatMode) return;
    setSelectedMode(defaultMode);
  }, [defaultMode, storedChatMode]);
  useEffect(() => {
    setSelectedPersona(storedChatPersona || DEFAULT_CHAT_PERSONA);
  }, [accountId, storedChatPersona]);
  useEffect(() => {
    if (!signedOut) return;
    setTaskRequestMode(false);
    setContextEditMode(false);
    setContextRewriteMode(false);
    setDeepResearchMode(false);
    setSelectedMode("Help");
    setSelectedPersona(DEFAULT_CHAT_PERSONA);
    setPlusMenuOpen(false);
    setPersonaMenuOpen(false);
    setModalityMenuOpen(false);
    setHistoryLoading(false);
  }, [signedOut]);
  useEffect(() => {
    if (clearedChatRef.current) return;
    if (activeChat?.source === "mock" || activeChat?.source === "server" || activeChat?.source === "live") return;
    setHistoryLoading(false);
    setTurns(normalizeChatMessages(messages));
  }, [activeChat?.source, messages]);
  useEffect(() => {
    if (chatResetKey === 0 || resetSeenRef.current === chatResetKey) return;
    resetSeenRef.current = chatResetKey;
    clearedChatRef.current = true;
    setTurns([]);
    setInput("");
    setAttachments([]);
    setTaskRequestMode(false);
    setContextEditMode(false);
    setContextRewriteMode(false);
    setDeepResearchMode(false);
    setSendMessage("");
    setActualUsage(null);
    setStatusTone("muted");
    setHistoryLoading(false);
    setDraftConversationId(newClientConversationId());
    setEditingMsg(null);
    setShareOpen(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [chatResetKey]);
  useEffect(() => {
    if (!activeChat || activeChat.source === "live") {
      setHistoryLoading(false);
      return undefined;
    }
    clearedChatRef.current = false;
    setTaskRequestMode(false);
    setContextEditMode(false);
    setContextRewriteMode(false);
    setDeepResearchMode(false);
    setSendMessage("");
    setActualUsage(null);
    setStatusTone("muted");
    if (activeChat.source !== "server") {
      setHistoryLoading(false);
      setTurns(createRecentPlaceholderThread(activeChat.title));
      return undefined;
    }
    const conversationId = activeChat.conversationId || activeChat.id;
    let cancelled = false;
    loadConversationHistory(conversationId, { shouldApply: () => !cancelled })
      .then(() => {
        if (cancelled) return;
      })
      .catch((error) => {
        if (cancelled) return;
        setStatusTone("error");
        setSendMessage(error?.message || "Could not load this conversation.");
        setHistoryLoading(false);
        setTurns([
          createErrorAssistantTurn(
            `history-error-${Date.now()}`,
            "Could not load this conversation.",
            Date.now()
          ),
        ]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeChat, chatSelectionKey, loadConversationHistory]);
  useEffect(() => {
    if (shareSeenRef.current === chatShareRequestKey) return;
    shareSeenRef.current = chatShareRequestKey;
    if (turns.length > 0) setShareOpen(true);
  }, [chatShareRequestKey, turns.length]);
  useEffect(() => {
    if (!contextRefinePending) return;
    onContextRefineHandled?.();
    if (signedOut) return;
    setTaskRequestMode(false);
    setContextRewriteMode(false);
    setDeepResearchMode(false);
    setContextEditMode(true);
    setSendMessage("");
    setStatusTone("muted");
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [contextRefinePending, onContextRefineHandled, signedOut]);
  useEffect(() => {
    if (!contextRewritePending) return;
    onContextRewriteHandled?.();
    if (signedOut) return;
    setTaskRequestMode(false);
    setContextEditMode(false);
    setDeepResearchMode(false);
    setContextRewriteMode(true);
    setSendMessage("Context Rewrite uses multiple model calls and web research, so the charge may be higher than a normal chat call.");
    setStatusTone("muted");
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [contextRewritePending, onContextRewriteHandled, signedOut]);
  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, CHAT_COMPOSER_MAX_HEIGHT)}px`;
  }, [input]);
  useEffect(() => {
    if (!shareOpen) return undefined;
    function closeOverlay(event) {
      if (event.key === "Escape") {
        setShareOpen(false);
      }
    }
    document.addEventListener("keydown", closeOverlay);
    return () => document.removeEventListener("keydown", closeOverlay);
  }, [shareOpen]);
  useEffect(() => {
    function closeMenus(event) {
      if (plusRef.current && !plusRef.current.contains(event.target)) {
        setPlusMenuOpen(false);
        setPersonaMenuOpen(false);
        setModalityMenuOpen(false);
      }
      if (modelRef.current && !modelRef.current.contains(event.target)) {
        setModelMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", closeMenus);
    return () => document.removeEventListener("mousedown", closeMenus);
  }, []);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const list = messageListRef.current;
      if (!list) {
        setShowScrollBottom(false);
        return;
      }
      if (scrollNearBottomRef.current) {
        list.scrollTo({
          top: list.scrollHeight,
          behavior: "auto",
        });
        setShowScrollBottom(false);
        return;
      }
      updateScrollBottomVisibility();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [turns, input, sending, updateScrollBottomVisibility]);
  async function submitMessage(event) {
    event.preventDefault();
    if (sending) return;
    if (activeChat?.readOnly) {
      setSendMessage("Historical conversations are read-only. Start a new chat to continue.");
      setStatusTone("muted");
      return;
    }
    const message = input.trim();
    if (!message && attachments.length === 0) return;
    if (activeModality?.requiresQuestion && !message) {
      setSendMessage("Ask a specific question before casting the I Ching.");
      setStatusTone("error");
      window.setTimeout(() => inputRef.current?.focus(), 0);
      return;
    }
    clearedChatRef.current = false;
    const startedAt = Date.now();
    const requestedConversationId = activeChat?.conversationId || activeChat?.id || draftConversationId;
    const isTaskRequest = taskRequestMode;
    const isDeepResearch = deepResearchMode && !isTaskRequest;
    const isContextRewrite = contextRewriteMode && !isTaskRequest && !isDeepResearch;
    const isContextEdit = contextEditMode && !isTaskRequest && !isDeepResearch && !isContextRewrite;
    const isHiveContext = isHiveChat && !isTaskRequest && !isDeepResearch && !isContextEdit && !isContextRewrite;
    const requestId = isTaskRequest ? newClientCorrelationId("req") : "";
    const deepResearchRequestId = isDeepResearch ? newClientCorrelationId("deepresearch") : "";
    const bundleId = isTaskRequest ? newClientCorrelationId("bundle") : "";
    const taskRequestMessageId = requestId ? `msg_${requestId}_request_user`.slice(0, 180) : "";
    const taskRequestAssistantId = requestId ? `msg_${requestId}_request_assistant`.slice(0, 180) : "";
    const contextRewriteMessageId = isContextRewrite ? `msg_${newClientCorrelationId("ctxrw")}_user`.slice(0, 180) : "";
    const deepResearchMessageId = isDeepResearch ? `msg_${deepResearchRequestId}_user`.slice(0, 180) : "";
    const deepResearchAssistantId = isDeepResearch ? `msg_${deepResearchRequestId}_assistant`.slice(0, 180) : "";
    const hiveContextMessageId = isHiveContext ? `msg_${newClientCorrelationId("hive")}_user`.slice(0, 180) : "";
    const hiveContextAssistantId = isHiveContext ? `${hiveContextMessageId}_assistant`.slice(0, 180) : "";
    const chatRequestId = !isTaskRequest && !isDeepResearch && !isContextRewrite && !isHiveContext
      ? newClientCorrelationId("chatreq")
      : "";
    const chatUserMessageId = chatRequestId ? `msg_${chatRequestId}_user`.slice(0, 180) : "";
    const chatAssistantMessageId = chatRequestId ? `msg_${chatRequestId}_assistant`.slice(0, 180) : "";
    const pendingId = taskRequestAssistantId || deepResearchAssistantId || hiveContextAssistantId || chatAssistantMessageId || `assistant-pending-${startedAt}`;
    const submittedAttachments = attachments;
    const fallbackPrompt = promptForAttachments(submittedAttachments);
    const submittedText = message || fallbackPrompt;
    const taskRequestMetadata = isTaskRequest
      ? {
          schema: "pf.task.request_intent.v1",
          kind: "task_request_intent",
          requestId,
          bundleId,
          conversationId: requestedConversationId,
          taskRequestMessageId,
          requestText: TASK_REQUEST_CANONICAL_TEXT,
          userDetailText: submittedText,
          requestedTaskKind: "personal",
          source: "user_chat",
          sourceConversationTitle: activeChat?.title || titleFromTurns(turns) || "New chat",
          status: "intent_pending",
        }
      : undefined;
    const contextEditMetadata = isContextEdit ? { kind: CONTEXT_EDIT_MODE } : undefined;
    const contextRewriteMetadata = isContextRewrite
      ? {
          kind: CONTEXT_REWRITE_MODE,
          contextRewrite: {
            status: "queued",
            stage: "queued",
            warning: "Context Rewrite runs multiple model calls and web research. The charge may be higher than other tool calls.",
          },
        }
      : undefined;
    const deepResearchMetadata = isDeepResearch
      ? {
          kind: DEEP_RESEARCH_MODE,
          deepResearch: {
            status: "starting",
            stage: "starting",
            title: "Deep Research",
            privacy: "Runs through the private Corbanu research service.",
          },
        }
      : undefined;
    const hiveContextMetadata = isHiveContext
      ? {
          kind: "hive_context_entry",
          source: "hive_chat",
          conversationId: requestedConversationId,
          sourceConversationTitle: HIVE_CHAT_TITLE,
      }
      : undefined;
    const personaMetadata = !isTaskRequest && !isDeepResearch && !isContextRewrite && !isContextEdit && !isHiveContext
      ? { chatPersona: selectedPersona }
      : undefined;
    const turnMetadata = taskRequestMetadata || deepResearchMetadata || contextRewriteMetadata || contextEditMetadata || hiveContextMetadata || personaMetadata;
    if (isTaskRequest && !walletReady) {
      if (["unlock", "open_wallet"].includes(taskRequestUnlockPolicy.action)) onWalletUnlock?.();
      setSendMessage(taskRequestUnlockPolicy.message);
      setStatusTone("error");
      return;
    }
    setSending(true);
    setSendMessage("");
    setActualUsage(null);
    setStatusTone("muted");
    setInput("");
    setAttachments([]);
    const submittedUserTurn = createUserTurn(
        submittedText,
        taskRequestMessageId || deepResearchMessageId || contextRewriteMessageId || hiveContextMessageId || chatUserMessageId || `user-local-${startedAt}`,
        submittedAttachments,
        turnMetadata
      );
    setTurns((current) => (
      [...current, submittedUserTurn, createPendingAssistantTurn(pendingId, startedAt, turnMetadata)]
    ));
    if (!activeChat) {
      onActiveChatChange?.({
        id: requestedConversationId,
        conversationId: requestedConversationId,
        source: "live",
        kind: isHiveContext ? "hive" : undefined,
        title: isTaskRequest ? "Task request" : isDeepResearch ? "Deep Research" : isContextRewrite ? "Context Rewrite" : isHiveContext ? HIVE_CHAT_TITLE : chatTitleFromPrompt(message),
      });
    }
    try {
      if (isTaskRequest) {
        const result = await publishTaskRequest({
          accountId,
          linkedWalletAddress,
          walletSecret,
          requestId,
          bundleId,
          conversationId: requestedConversationId,
          userDetailText: submittedText,
          requestedTaskKind: "personal",
          source: "user_chat",
          sourceConversationTitle: activeChat?.title || titleFromTurns(turns) || "New chat",
          attachments: serializeChatAttachments(submittedAttachments),
          onProgress: (label) => {
            setSendMessage(label);
            setStatusTone("muted");
          },
        });
        const directRecorded = result?.offchainLifecycle?.writeSource === "direct_write" ||
          String(result?.txHash || "").startsWith("offchain:");
        const receipt = directRecorded
          ? "Task request recorded in Task Node."
          : `Task request published to PFT. Transaction ${String(result.txHash || "").slice(0, 12)}...`;
        const assistantTurn = normalizeChatMessage(
          {
            id: taskRequestAssistantId,
            role: "assistant",
            body: receipt,
            metadata: {
              ...taskRequestMetadata,
              status: directRecorded ? "task_request_recorded" : "pftl_request_published",
              requestEventCid: result.cid,
              requestBundleCid: result.bundleCid,
              txHash: result.txHash,
            },
          },
          pendingId
        );
        setTurns((current) => replaceTurnById(current, pendingId, { ...assistantTurn, id: pendingId }));
        setTaskRequestMode(false);
        setSendMessage(directRecorded ? "Task request recorded." : "Task request published to PFT.");
        setStatusTone("muted");
        setDraftConversationId(requestedConversationId);
        onActiveChatChange?.({
          id: requestedConversationId,
          conversationId: requestedConversationId,
          source: "live",
          title: activeChat?.title || "Task request",
        });
        await onChatSettled?.({ taskProjectionRefresh: true });
        return;
      }
      if (isDeepResearch) {
        const result = await createDeepResearchJob({
          question: submittedText,
          conversationId: requestedConversationId,
          requestId: deepResearchRequestId,
          title: chatTitleFromPrompt(submittedText),
        });
        if (!result.ok || !result.body?.job) {
          throw new Error(result.body?.message || `Deep Research returned HTTP ${result.status}.`);
        }
        if (result.body.user) {
          const userTurn = normalizeChatMessage(result.body.user, 0);
          if (userTurn) setTurns((current) => replaceTurnById(current, deepResearchMessageId, userTurn));
        }
        if (result.body.assistant) {
          const assistantTurn = normalizeChatMessage({
            ...result.body.assistant,
            thinking: { state: "running", ...(result.body.assistant.thinking || {}) },
          }, pendingId);
          if (assistantTurn) {
            setTurns((current) => replaceTurnById(
              current,
              pendingId,
              { ...assistantTurn, id: pendingId, pending: true },
            ));
          }
        }
        setDeepResearchMode(false);
        setSendMessage(result.body.message || "Deep Research queued. You can leave and return to this chat.");
        setStatusTone("muted");
        const settledConversationId = result.body?.job?.conversationId || requestedConversationId;
        setDraftConversationId(settledConversationId);
        onActiveChatChange?.({
          id: settledConversationId,
          conversationId: settledConversationId,
          source: "live",
          title: activeChat?.title || "Deep Research",
        });
        await onChatSettled?.();
        void pollDeepResearchJob(result.body.job.id, pendingId, startedAt);
        return;
      }
      if (isContextRewrite) {
        const result = await createContextRewriteJob({
          message: submittedText,
          conversationId: requestedConversationId,
        });
        if (!result.ok || !result.body?.job) {
          throw new Error(result.body?.message || result.body?.actionRequired || `Context Rewrite returned HTTP ${result.status}.`);
        }
        if (result.body.user) {
          const userTurn = normalizeChatMessage(result.body.user, 0);
          if (userTurn) {
            setTurns((current) => replaceTurnById(current, contextRewriteMessageId, userTurn));
          }
        }
        if (result.body.assistant) {
          replaceContextRewriteAssistant(pendingId, result.body.assistant, startedAt, { pending: true });
        }
        setContextRewriteMode(false);
        setSendMessage(result.body.message || "Context Rewrite queued. Check back in this tab.");
        setStatusTone("muted");
        const settledConversationId = result.body?.job?.conversationId || requestedConversationId;
        setDraftConversationId(settledConversationId);
        onActiveChatChange?.({
          id: settledConversationId,
          conversationId: settledConversationId,
          source: "live",
          title: activeChat?.title || "Context Rewrite",
        });
        await onChatSettled?.();
        void pollContextRewriteJob(result.body.job.id, pendingId, startedAt);
        return;
      }
      if (isHiveContext) {
        const result = await requestJson("/api/hive/context", {
          method: "POST",
          headers: { "content-type": "application/json" },
            body: JSON.stringify({
              body: submittedText,
              conversationId: requestedConversationId,
              conversationTitle: HIVE_CHAT_TITLE,
              attachments: serializeChatAttachments(submittedAttachments),
              userMessageId: hiveContextMessageId,
              assistantMessageId: hiveContextAssistantId,
          }),
        });
        if (!result.ok || !result.body?.entry) {
          throw new Error(result.body?.message || `Hive Context returned HTTP ${result.status}.`);
        }
        if (result.body.user) {
          const userTurn = normalizeChatMessage(result.body.user, 0);
          if (userTurn) {
            setTurns((current) => replaceTurnById(current, hiveContextMessageId, userTurn));
          }
        }
        if (result.body.assistant) {
          const assistantTurn = normalizeChatMessage(result.body.assistant, pendingId);
          setTurns((current) => replaceTurnById(current, pendingId, { ...assistantTurn, id: pendingId }));
        } else {
          setTurns((current) => replaceTurnById(
            current,
            pendingId,
            {
              id: `hive-status-${result.body.entry.id || startedAt}`,
              role: "assistant",
              metadata: { kind: "hive_context_status", hiveContextEntryId: result.body.entry.id },
              blocks: [
                {
                  type: "p",
                  inline: [{ text: result.body.message || "Saved to Hive Context. Hive may respond here if useful." }],
                },
              ],
            }
          ));
        }
        setSendMessage("");
        setStatusTone("muted");
        const settledConversationId = result.body?.user?.conversationId || requestedConversationId;
        setDraftConversationId(settledConversationId);
        onActiveChatChange?.({
          id: settledConversationId,
          conversationId: settledConversationId,
          source: "live",
          kind: "hive",
          title: HIVE_CHAT_TITLE,
        });
        if (result.body.assistant) {
          await loadConversationHistory(settledConversationId, { showLoading: false }).catch(() => null);
        }
        await onChatSettled?.();
        return;
      }
      const chatPayload = {
        message: submittedText,
        mode: isContextEdit || activeModality ? "Thinking" : signedOut ? "Help" : selectedMode,
        persona: isContextEdit ? DEFAULT_CHAT_PERSONA : selectedPersona,
        contextMode: isContextEdit ? CONTEXT_EDIT_MODE : undefined,
        conversationId: requestedConversationId,
        clientRequestId: chatRequestId,
        userMessageId: chatUserMessageId,
        assistantMessageId: chatAssistantMessageId,
        attachments: serializeChatAttachments(submittedAttachments),
        clientHistory: signedOut && !isContextEdit ? clientHistoryPayloadFromTurns(turns) : undefined,
      };
      const requestController = new AbortController();
      activeRequestAbortRef.current?.abort();
      activeRequestAbortRef.current = requestController;
      const result = usage?.chatStreamPath && !isContextEdit
        ? await requestEventStream(
            usage.chatStreamPath,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(chatPayload),
              signal: requestController.signal,
            },
            ({ event, body }) => {
              if (event === "delta" && body?.delta) {
                setTurns((current) =>
                  appendAssistantDelta(current, pendingId, body.delta, startedAt)
                );
              } else if (event === "progress" && Number.isFinite(Number(body?.elapsedMs))) {
                setTurns((current) =>
                  updatePendingAssistantProgress(current, pendingId, Number(body.elapsedMs), startedAt)
                );
              }
            },
            {
              onRetry: ({ retryCount, maxRetries }) => {
                setTurns((current) => replaceTurnById(
                  current,
                  pendingId,
                  createPendingAssistantTurn(pendingId, startedAt, turnMetadata)
                ));
                setSendMessage(`Connection interrupted. Reconnecting ${retryCount}/${maxRetries}…`);
                setStatusTone("muted");
              },
            }
          )
        : await requestJson(usage?.chatSendPath || "/api/chat/send", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(chatPayload),
            signal: requestController.signal,
          });
      setActualUsage(result.body?.usage || null);
      if (result.ok && result.body?.assistant) {
        const settledConversationId = result.body?.conversationId || requestedConversationId;
        const assistantTurn = normalizeChatMessage(
          {
            ...result.body.assistant,
            thinking: {
              state: "finished",
              duration: formatElapsedSeconds(Date.now() - startedAt),
              ...(result.body.assistant.metadata?.thinking || {}),
              ...(result.body.assistant.thinking || {}),
            },
          },
          pendingId
        );
        setTurns((current) => replaceTurnById(current, pendingId, { ...assistantTurn, id: pendingId }));
        setSendMessage(result.body.message || (isContextEdit ? "Context edit response generated." : "Chat response generated."));
        setStatusTone("muted");
        setDraftConversationId(settledConversationId);
        onActiveChatChange?.({
          id: settledConversationId,
          conversationId: settledConversationId,
          source: "live",
          title: activeChat?.title || chatTitleFromPrompt(submittedText),
        });
        await onChatSettled?.();
      } else {
        const failureMessage =
          result.body?.message ||
          result.body?.actionRequired ||
          `Chat returned HTTP ${result.status}.`;
        if (result.body?.error === "i_ching_profile_required") setIChingSetupOpen(true);
        setTurns((current) =>
          replaceTurnById(
            current,
            pendingId,
            createErrorAssistantTurn(pendingId, failureMessage, startedAt)
          )
        );
        setSendMessage(
          failureMessage
        );
        setStatusTone("error");
      }
    } catch (error) {
      if (error?.name === "AbortError" || activeRequestAbortRef.current?.signal?.aborted) return;
      const failureMessage = error?.message || "Chat execution is unavailable.";
      setTurns((current) =>
        replaceTurnById(
          current,
          pendingId,
          createErrorAssistantTurn(pendingId, failureMessage, startedAt)
        )
      );
      setInput(message);
      setAttachments(submittedAttachments);
      setSendMessage(failureMessage);
      setStatusTone("error");
    } finally {
      activeRequestAbortRef.current = null;
      setSending(false);
    }
  }
  async function attachFiles(fileList, { source = "upload" } = {}) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    const remainingSlots = Math.max(0, CHAT_ATTACHMENT_MAX_COUNT - attachments.length);
    const selectedFiles = files.slice(0, remainingSlots);
    if (selectedFiles.length === 0) {
      setSendMessage(`Attach up to ${CHAT_ATTACHMENT_MAX_COUNT} files at a time.`);
      setStatusTone("error");
      return;
    }
    try {
      const nextAttachments = [];
      for (const file of selectedFiles) {
        if (file.size > CHAT_ATTACHMENT_MAX_BYTES) {
          throw new Error(`${file.name} is larger than ${formatFileSize(CHAT_ATTACHMENT_MAX_BYTES)}.`);
        }
        const dataUrl = await readFileAsDataUrl(file);
        nextAttachments.push({
          id: `att-${Date.now()}-${nextAttachments.length}-${file.name}`,
          name: file.name || "attachment",
          mimeType: file.type || mimeTypeFromFilename(file.name),
          size: file.size,
          source,
          dataUrl,
        });
      }
      setAttachments((current) => [...current, ...nextAttachments].slice(0, CHAT_ATTACHMENT_MAX_COUNT));
      setSendMessage("");
      setStatusTone("muted");
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } catch (error) {
      setSendMessage(error?.message || "Could not attach that file.");
      setStatusTone("error");
    }
  }
  async function handleAttachmentSelection(event) {
    await attachFiles(event.target.files, { source: "upload" });
    event.target.value = "";
  }
  function dataTransferHasFiles(dataTransfer) {
    const types = Array.from(dataTransfer?.types || []);
    if (types.includes("Files")) return true;
    return Array.from(dataTransfer?.items || []).some((item) => item.kind === "file");
  }
  function handleComposerDragEnter(event) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current += 1;
    setComposerDragActive(true);
  }
  function handleComposerDragOver(event) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setComposerDragActive(true);
  }
  function handleComposerDragLeave(event) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current = Math.max(0, composerDragDepthRef.current - 1);
    if (composerDragDepthRef.current === 0) setComposerDragActive(false);
  }
  async function handleComposerDrop(event) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current = 0;
    setComposerDragActive(false);
    await attachFiles(event.dataTransfer.files, { source: "drag_drop" });
  }
  function removeAttachment(id) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }
  function handleComposerPaste(event) {
    const pasted = event.clipboardData?.getData("text/plain") || "";
    if (pasted.length <= CHAT_PASTE_ATTACHMENT_THRESHOLD) return;
    const pastedSize = byteSize(pasted);
    if (pastedSize > CHAT_ATTACHMENT_MAX_BYTES || attachments.length >= CHAT_ATTACHMENT_MAX_COUNT) return;
    event.preventDefault();
    const attachment = createPastedTextAttachment(pasted, pastedSize);
    setAttachments((current) => [...current, attachment].slice(0, CHAT_ATTACHMENT_MAX_COUNT));
    setSendMessage("");
    setStatusTone("muted");
  }
  function showAttachmentInTextField(attachment) {
    const text = textFromAttachment(attachment);
    if (!text) return;
    setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    setInput((current) => (current ? `${current}\n${text}` : text));
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }
  async function handleContextEditApply(proposal) {
    if (!proposal?.id || contextEditSavingId) return;
    setContextEditSavingId(proposal.id);
    try {
      const result = await applyContextEditProposal(proposal.id);
      if (result.ok && result.body?.proposal) {
        setTurns((current) => patchContextEditProposalTurn(current, proposal.id, result.body.proposal));
        setSendMessage(result.body.message || "Context updated.");
        setStatusTone("muted");
        await onChatSettled?.();
      } else {
        throw new Error(result.body?.message || "Context edit could not be applied.");
      }
    } catch (error) {
      const errorText = error?.message || "Context edit could not be applied.";
      setTurns((current) => patchContextEditProposalTurn(current, proposal.id, { error: errorText }));
      setSendMessage(errorText);
      setStatusTone("error");
    } finally {
      setContextEditSavingId("");
    }
  }
  async function handleContextEditReject(proposal) {
    if (!proposal?.id || contextEditSavingId) return;
    setContextEditSavingId(proposal.id);
    try {
      const result = await rejectContextEditProposal(proposal.id);
      if (!result.ok || !result.body?.proposal) {
        throw new Error(result.body?.message || "Context edit could not be rejected.");
      }
      setTurns((current) => patchContextEditProposalTurn(current, proposal.id, result.body.proposal));
      setSendMessage("Context edit rejected.");
      setStatusTone("muted");
    } catch (error) {
      setSendMessage(error?.message || "Context edit could not be rejected.");
      setStatusTone("error");
    } finally {
      setContextEditSavingId("");
    }
  }
  function handleContextEditRevise(proposal) {
    setContextRewriteMode(false);
    setDeepResearchMode(false);
    setContextEditMode(true);
    setInput(`Revise this context edit: ${proposal?.rationale || ""}`.trim());
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }
  const composerStatus = chatComposerStatus({
    actualUsage,
    message: sendMessage,
    sending,
    tone: statusTone,
    turns,
  });
  const showComposerStatus =
    composerStatus &&
    !(isHiveChat && composerStatus.text === "Task Node can make mistakes. Check important info.");
  const chatTitle = activeChat?.title || titleFromTurns(turns);
  const displayState = chatSurfaceDisplayState({ activeChat, turns, historyLoading });
  const activePersona = chatPersonaDefinition(selectedPersona);
  const activeModality = chatPersonaIsModality(selectedPersona) ? activePersona : null;
  const historicalReadOnly = Boolean(activeChat?.readOnly);
  const hasPromptInput = activeModality?.requiresQuestion
    ? input.trim().length > 0
    : input.trim().length > 0 || attachments.length > 0;
  const composerExpanded = input.length > 0;
  const composerPlaceholder = historicalReadOnly
    ? "Historical conversation is read-only"
    : taskRequestMode
    ? TASK_REQUEST_PLACEHOLDER
    : deepResearchMode
      ? DEEP_RESEARCH_PLACEHOLDER
    : contextRewriteMode
      ? CONTEXT_REWRITE_PLACEHOLDER
      : contextEditMode
      ? CONTEXT_EDIT_PLACEHOLDER
      : isHiveChat
        ? HIVE_CHAT_PLACEHOLDER
        : activeModality?.inputPlaceholder || "Ask anything";
  const composerClassName = [
    "composer",
    composerDragActive ? "is-drag-active" : "",
    taskRequestMode ? "is-task-request" : "",
    deepResearchMode ? "is-deep-research" : "",
    contextRewriteMode ? "is-context-rewrite" : "",
    contextEditMode ? "is-context-edit" : "",
    isHiveChat ? "is-hive-input" : "",
  ].filter(Boolean).join(" ");
  const modelPickerDisabled = contextEditMode || contextRewriteMode || deepResearchMode || isHiveChat || Boolean(activeModality);
  const ActivePersonaIcon = CHAT_PERSONA_ICONS[activePersona.id] || Lightbulb;
  const modelPickerLabel = deepResearchMode
    ? "Deep Research"
    : contextRewriteMode
    ? "Context Rewrite"
    : contextEditMode
    ? "Thinking carefully"
    : isHiveChat
      ? HIVE_CHAT_TITLE
      : activeModality
        ? "GLM 5.2"
      : formatModeLabel(selectedMode);
  const composer = (
    <div className="composer-shell">
      <input
        ref={fileInputRef}
        accept={CHAT_ATTACHMENT_ACCEPT}
        className="chat-file-input"
        multiple
        onChange={handleAttachmentSelection}
        type="file"
      />
      <form
        className={composerClassName}
        onDragEnter={handleComposerDragEnter}
        onDragLeave={handleComposerDragLeave}
        onDragOver={handleComposerDragOver}
        onDrop={handleComposerDrop}
        onSubmit={submitMessage}
      >
        {attachments.length > 0 && (
          <AttachmentTray
            attachments={attachments}
            onRemove={removeAttachment}
            onShowInText={showAttachmentInTextField}
          />
        )}
        {contextEditMode && (
          <div className="composer-mode-chip">
            <Wand2 size={13} strokeWidth={1.9} />
            <span>Context Refine</span>
            <button aria-label="Exit Context Refine" onClick={() => setContextEditMode(false)} type="button">
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        )}
        {deepResearchMode && (
          <div className="composer-mode-chip">
            <Search size={13} strokeWidth={1.9} />
            <span>Deep Research</span>
            <button aria-label="Exit Deep Research" onClick={() => setDeepResearchMode(false)} type="button">
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        )}
        {contextRewriteMode && (
          <div className="composer-mode-chip">
            <FileText size={13} strokeWidth={1.9} />
            <span>Context Rewrite</span>
            <button aria-label="Exit Context Rewrite" onClick={() => setContextRewriteMode(false)} type="button">
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        )}
        {isHiveChat && (
          <div className="composer-mode-chip">
            <Network size={13} strokeWidth={1.9} />
            <span>{HIVE_CHAT_TITLE}</span>
          </div>
        )}
        {activeModality && !isHiveChat && (
          <div className="composer-mode-chip">
            <ActivePersonaIcon size={13} strokeWidth={1.9} />
            <span>{activeModality.name}</span>
            {activeModality.id === "i-ching" && iChingProfileSummary && (
              <span className="i-ching-profile-ready-chip">
                <Check size={11} strokeWidth={2.4} />
                Profile ready
              </span>
            )}
            <button
              aria-label={`Exit ${activeModality.name}`}
              onClick={() => {
                setSelectedPersona(DEFAULT_CHAT_PERSONA);
                if (chatPersonaStorageKey) {
                  try {
                    window.localStorage?.setItem(chatPersonaStorageKey, DEFAULT_CHAT_PERSONA);
                  } catch {
                    /* storage unavailable: selection still applies for this session */
                  }
                }
              }}
              type="button"
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        )}
        <div className={composerExpanded ? "composer-grid is-expanded" : "composer-grid is-compact"}>
          <div className="plus-picker composer-plus" ref={plusRef}>
            <button
              className="composer-icon"
              disabled={signedOut || historicalReadOnly}
              onClick={() => {
                if (signedOut) return;
                setModelMenuOpen(false);
                setPlusMenuOpen((open) => {
                  if (open) {
                    setPersonaMenuOpen(false);
                    setModalityMenuOpen(false);
                  }
                  return !open;
                });
              }}
              type="button"
              aria-label={signedOut ? "Sign in for app actions" : "Add"}
            >
              <Plus size={20} strokeWidth={1.75} />
            </button>
            {plusMenuOpen && (
              <div className={`plus-menu${personaMenuOpen ? " has-personas" : ""}${modalityMenuOpen ? " has-modalities" : ""}`}>
                <ToolMenuRow
                  icon={Paperclip}
                  label="Upload photos & files"
                  onClick={() => {
                    setPlusMenuOpen(false);
                    fileInputRef.current?.click();
                  }}
                />
                <div className="menu-divider" />
                <ToolMenuRow
                  icon={Wand2}
                  label="Context Refine"
                  onClick={() => {
                    setPlusMenuOpen(false);
                    setTaskRequestMode(false);
                    setContextRewriteMode(false);
                    setDeepResearchMode(false);
                    setContextEditMode(true);
                    setSendMessage("");
                    setStatusTone("muted");
                    window.setTimeout(() => inputRef.current?.focus(), 0);
                  }}
                />
                <ToolMenuRow
                  icon={FileText}
                  label="Context Rewrite"
                  onClick={() => {
                    setPlusMenuOpen(false);
                    setTaskRequestMode(false);
                    setContextEditMode(false);
                    setDeepResearchMode(false);
                    setContextRewriteMode(true);
                    setSendMessage("Context Rewrite uses multiple model calls and web research, so the charge may be higher than a normal chat call.");
                    setStatusTone("muted");
                    window.setTimeout(() => inputRef.current?.focus(), 0);
                  }}
                />
                <ToolMenuRow
                  disabled={chat?.deepResearchAvailable !== true}
                  icon={Search}
                  label={chat?.deepResearchAvailable === true ? "Deep Research" : "Deep Research · Canary"}
                  onClick={() => {
                    setPlusMenuOpen(false);
                    setTaskRequestMode(false);
                    setContextEditMode(false);
                    setContextRewriteMode(false);
                    setDeepResearchMode(true);
                    setSendMessage("Deep Research runs privately through Corbanu and can take several minutes. You can leave and return to the chat.");
                    setStatusTone("muted");
                    window.setTimeout(() => inputRef.current?.focus(), 0);
                  }}
                />
                <ToolMenuRow
                  icon={ListPlus}
                  label="Request a task"
                  onClick={() => {
                    setPlusMenuOpen(false);
                    setTaskRequestMode(true);
                    setContextEditMode(false);
                    setContextRewriteMode(false);
                    setDeepResearchMode(false);
                    setSendMessage("");
                    setStatusTone("muted");
                    window.setTimeout(() => inputRef.current?.focus(), 0);
                  }}
                />
                <ToolMenuRow
                  icon={Drama}
                  label="Personality"
                  onClick={() => {
                    setModalityMenuOpen(false);
                    setPersonaMenuOpen((open) => !open);
                  }}
                  trailing={(
                    <span className="personality-menu-current">
                      {activePersona.name}
                      <ChevronRight
                        className={personaMenuOpen ? "is-open" : ""}
                        size={14}
                        strokeWidth={1.75}
                      />
                    </span>
                  )}
                />
                {personaMenuOpen && (
                  <div className="personality-menu" role="menu" aria-label="Chat personality">
                    {CHAT_PERSONAS.map((persona) => {
                      const PersonaIcon = CHAT_PERSONA_ICONS[persona.id] || Lightbulb;
                      const selected = persona.id === selectedPersona;
                      return (
                        <button
                          aria-checked={selected}
                          className={`personality-menu-row${selected ? " selected" : ""}`}
                          key={persona.id}
                          onClick={() => {
                            setSelectedPersona(persona.id);
                            if (chatPersonaStorageKey) {
                              try {
                                window.localStorage?.setItem(chatPersonaStorageKey, persona.id);
                              } catch {
                                /* storage unavailable: selection still applies for this session */
                              }
                            }
                            setTaskRequestMode(false);
                            setContextEditMode(false);
                            setContextRewriteMode(false);
                            setDeepResearchMode(false);
                            setPersonaMenuOpen(false);
                            setPlusMenuOpen(false);
                            window.setTimeout(() => inputRef.current?.focus(), 0);
                          }}
                          role="menuitemradio"
                          type="button"
                        >
                          <PersonaIcon size={17} strokeWidth={1.75} />
                          <span>
                            <strong>{persona.name}</strong>
                            <small>{persona.tagline}</small>
                          </span>
                          {selected && <Check size={15} strokeWidth={2} />}
                        </button>
                      );
                    })}
                  </div>
                )}
                <ToolMenuRow
                  icon={MoreHorizontal}
                  label="More"
                  onClick={() => {
                    setPersonaMenuOpen(false);
                    setModalityMenuOpen((open) => !open);
                  }}
                  trailing={(
                    <span className="personality-menu-current">
                      {activeModality?.name || "Modes"}
                      <ChevronRight
                        className={modalityMenuOpen ? "is-open" : ""}
                        size={14}
                        strokeWidth={1.75}
                      />
                    </span>
                  )}
                />
                {modalityMenuOpen && (
                  <div className="personality-menu modality-menu" role="menu" aria-label="Chat modality">
                    {CHAT_MODALITIES.map((modality) => {
                      const ModalityIcon = CHAT_PERSONA_ICONS[modality.id] || Sparkles;
                      const selected = modality.id === selectedPersona;
                      return (
                        <button
                          aria-checked={selected}
                          className={`personality-menu-row${selected ? " selected" : ""}`}
                          key={modality.id}
                          onClick={() => void activateChatModality(modality)}
                          role="menuitemradio"
                          type="button"
                        >
                          <ModalityIcon size={17} strokeWidth={1.75} />
                          <span>
                            <strong>{modality.name}</strong>
                            <small>{modality.tagline}</small>
                          </span>
                          {selected && <Check size={15} strokeWidth={2} />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
          <textarea
            ref={inputRef}
            aria-label={composerPlaceholder}
            className="composer-input"
            disabled={historicalReadOnly}
            onChange={(event) => setInput(event.target.value)}
            onPaste={handleComposerPaste}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent?.isComposing) {
                event.preventDefault();
                submitMessage(event);
              }
            }}
            placeholder={composerExpanded ? "" : composerPlaceholder}
            rows={1}
            style={{ maxHeight: CHAT_COMPOSER_MAX_HEIGHT }}
            value={input}
          />
          <div className="composer-tools">
            {selectedPersona !== DEFAULT_CHAT_PERSONA && !activeModality && !contextEditMode && !contextRewriteMode && !isHiveChat && (
              <span className="chat-persona-chip" title={`Personality: ${activePersona.name}`}>
                <ActivePersonaIcon size={13} strokeWidth={1.75} />
                {activePersona.name}
              </span>
            )}
            <div className="model-picker" ref={modelRef}>
              <button
                className="model-button"
                disabled={modelPickerDisabled}
                onClick={() => {
                  if (modelPickerDisabled) return;
                  setPlusMenuOpen(false);
                  setPersonaMenuOpen(false);
                  setModalityMenuOpen(false);
                  setModelMenuOpen((open) => !open);
                }}
                type="button"
              >
                {modelPickerLabel}
                <ChevronDown className={modelMenuOpen ? "is-open" : ""} size={14} strokeWidth={1.75} />
              </button>
              {modelMenuOpen && !modelPickerDisabled && (
                <div className="model-menu">
                  {modes.map((mode) => (
                    <ModelOption
                      disabled={!mode.enabled}
                      key={mode.label}
                      mode={mode}
                      selected={mode.label === selectedMode}
                      onClick={() => {
                        if (!mode.enabled) return;
                        setSelectedMode(mode.label);
                        if (chatModeStorageKey) {
                          try {
                            window.localStorage?.setItem(chatModeStorageKey, mode.label);
                          } catch {
                            /* storage unavailable: selection still applies for this session */
                          }
                        }
                        setModelMenuOpen(false);
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
            <ComposerSendButton disabled={historicalReadOnly || !hasPromptInput || sending} />
          </div>
        </div>
      </form>
      {showComposerStatus && (
        <div className={`chat-composer-note ${composerStatus.tone}${isHiveChat ? " is-hive-note" : ""}`}>
          {isHiveChat ? <em>{composerStatus.text}</em> : composerStatus.text}
        </div>
      )}
    </div>
  );
  return (
    <>
    <div className={displayState === "empty" ? "chat-surface empty" : `chat-surface ${displayState}`}>
      {displayState === "loading" ? (
        <div className="chat-loading-panel" aria-live="polite">
          <span>Loading chat</span>
          <strong>{chatTitle || "Conversation"}</strong>
        </div>
      ) : displayState === "empty" ? (
        <div className="chat-empty">
          <h1>{isHiveChat ? HIVE_CHAT_TITLE : "What are you working on?"}</h1>
          {composer}
          {!signedOut && !isHiveChat && (
            <div className="chat-starter-prompts">
              {CHAT_STARTER_PROMPTS.map((prompt) => (
                <button
                  className="pill-button"
                  key={prompt}
                  onClick={() => {
                    setInput(prompt);
                    window.setTimeout(() => inputRef.current?.focus(), 0);
                  }}
                  type="button"
                >
                  {prompt}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="chat-thread-shell">
          <div
            className="message-list"
            ref={messageListRef}
            aria-live="polite"
            onScroll={updateScrollBottomVisibility}
          >
            {turns.map((message, index) => {
              if (message.role === "user") {
                return (
                  <UserMessage
                    attachments={message.attachments || []}
                    draft={editDraft}
                    isEditing={editingMsg === index}
                    key={message.id || `user-${index}`}
                    onCancelEdit={() => setEditingMsg(null)}
                    onDraftChange={setEditDraft}
                    onSaveEdit={() => {
                      setTurns((current) =>
                        current.map((row, rowIndex) =>
                          rowIndex === index ? { ...row, text: editDraft } : row
                        )
                      );
                      setEditingMsg(null);
                    }}
                    onStartEdit={() => {
                      setEditingMsg(index);
                      setEditDraft(message.text || "");
                    }}
                    text={message.text}
                  />
                );
              }
              if (message.role === "agent") {
                return (
                  <AgentMessage
                    agentClient={message.agentClient}
                    agentLabel={message.agentLabel}
                    attachments={message.attachments || []}
                    key={message.id || `agent-${index}`}
                    text={message.text}
                  />
                );
              }
              return (
                <AssistantMessage
                  contextEditSavingId={contextEditSavingId}
                  key={message.id || `assistant-${index}`}
                  message={message}
                  onContextEditApply={handleContextEditApply}
                  onContextEditReject={handleContextEditReject}
                  onContextEditRevise={handleContextEditRevise}
                  onShare={() => setShareOpen(true)}
                />
              );
            })}
          </div>
          {showScrollBottom && (
            <button
              aria-label="Scroll to latest message"
              className="scroll-bottom-button"
              onClick={() => {
                const list = messageListRef.current;
                if (!list) return;
                list.scrollTo({
                  top: list.scrollHeight,
                  behavior: "auto",
                });
                scrollNearBottomRef.current = true;
                setShowScrollBottom(false);
              }}
              title="Scroll to bottom"
              type="button"
            >
              <ArrowDown size={14} strokeWidth={2} />
            </button>
          )}
          <div className="composer-dock">{composer}</div>
        </div>
      )}
      {shareOpen && (
        <ShareModal
          onClose={() => setShareOpen(false)}
          thread={turns}
          title={chatTitle}
        />
      )}
    </div>
    <IChingSetupDialog
      onCancel={() => {
        setIChingSetupOpen(false);
        persistChatPersona(DEFAULT_CHAT_PERSONA);
      }}
      onSaved={(profile) => {
        setIChingProfileSummary(profile || {});
        setIChingSetupOpen(false);
        setSendMessage("Your private birth chart is ready. Ask a specific question for the reading.");
        setStatusTone("muted");
        window.setTimeout(() => inputRef.current?.focus(), 0);
      }}
      open={iChingSetupOpen}
    />
    </>
  );
}
