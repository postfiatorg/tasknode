import { lazy } from "react";
import { Brain, MessageSquare, Users } from "lucide-react";

const HiveBrainView = lazy(() => import("../features/hive/HiveBrainView").then((module) => ({ default: module.HiveBrainView })));
const MemoryView = lazy(() => import("../features/memory/MemoryView").then((module) => ({ default: module.MemoryView })));
const MessagesView = lazy(() => import("../features/messages/MessagesView").then((module) => ({ default: module.MessagesView })));
const TeamView = lazy(() => import("../features/team/TeamView").then((module) => ({ default: module.TeamView })));

export const builtInTaskNodeExtensions = Object.freeze([
  {
    id: "messages",
    label: "Messages",
    icon: MessageSquare,
    component: MessagesView,
    group: "collaboration",
    order: 10,
    enabled: ({ runtimeConfig }) => Boolean(runtimeConfig?.collaboration?.messagesEnabled),
    props: ({ accountId, navigateToView, onWalletUnlock, walletSecret }) => ({
      accountId,
      onOpenProfile: () => navigateToView("profile"),
      onWalletUnlock,
      walletSecret,
    }),
  },
  {
    id: "team",
    label: "Team",
    icon: Users,
    component: TeamView,
    group: "collaboration",
    order: 20,
    enabled: ({ runtimeConfig }) => Boolean(runtimeConfig?.collaboration?.teamEnabled),
    props: ({ accountId, onWalletUnlock, walletSecret }) => ({ accountId, onWalletUnlock, walletSecret }),
  },
  {
    id: "hive-brain",
    label: "Hive Brain",
    icon: Brain,
    component: HiveBrainView,
    group: "insight",
    order: 30,
    requiresAuth: false,
  },
  {
    id: "memory",
    label: "Memory",
    icon: MessageSquare,
    component: MemoryView,
    group: "insight",
    order: 40,
    props: ({ appState }) => ({ session: appState?.session }),
  },
]);
