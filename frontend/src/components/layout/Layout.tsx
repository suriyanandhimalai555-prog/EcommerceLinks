import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import Header from './Header'

export default function Layout() {
  return (
    <div className="flex h-screen bg-gray-100 overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
        <footer className="bg-white border-t border-gray-200 py-3 px-6 flex justify-between items-center text-xs text-gray-400">
          <span>© 2025 Agila Vetri Groups. All Rights Reserved.</span>
          <span>Version 1.0.0</span>
        </footer>
      </div>
    </div>
  )
}
