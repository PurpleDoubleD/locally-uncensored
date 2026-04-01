import { create } from 'zustand'

export type View = 'chat' | 'models' | 'settings' | 'create' | 'agents'

interface UIState {
  currentView: View
  sidebarOpen: boolean
  setView: (view: View) => void
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
}

export const useUIStore = create<UIState>()((set) => ({
  currentView: 'models',
  sidebarOpen: true,

  setView: (view) => set({ currentView: view }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
}))
