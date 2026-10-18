import type { github as De } from "../de/github";

export const github: typeof De = {
  deviceCode: {
    copied: "Code copied",
    notCopied: "Code not copied",
    noClipboard: "The clipboard is not available. Please type the code.",
    oneTimeCode: "One-time code",
    copy: "Copy code",
    openGitHub: "Open GitHub",
    cancel: "Cancel",
    waiting: "Waiting for confirmation",
  },
  owner: {
    loading: "Loading organizations",
    personal: "Personal account",
    organization: "Organization",
    aria: "Account or organization",
    loadFailed: "Organizations could not be loaded.",
  },
  account: {
    loginNotStarted: "Sign-in not started",
    loading: "Loading GitHub account",
    profile: "Profile",
    signOut: "Sign out",
    logoutTitle: "Sign out of GitHub?",
    logoutDescription: "FORGE and git can no longer access your private repositories until you sign in again.",
    logoutFailed: "Sign-out failed",
    codePrompt: "Enter this code on the GitHub page that opened in your browser:",
    cancelFailed: "Cancel failed",
    intro:
      "Sign in to clone private repositories, push and create pull requests. Sign-in runs through GitHub in the browser; the token is stored in Windows Credential Manager, not in FORGE.",
    loginFailed: "Sign-in failed",
    signIn: "Sign in with GitHub",
  },
  repos: {
    searchPlaceholder: (login: string) => `Search repositories of ${login}`,
    searchAria: "Search repositories",
    loading: "Loading repositories",
    listAria: "Your repositories",
    private: "private",
    updated: (when: string) => `updated ${when}`,
    noResults: "No matches",
  },
};
