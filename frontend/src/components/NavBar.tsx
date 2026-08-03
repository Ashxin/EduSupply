'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function NavBar({ role }: { role: 'school' | 'vendor' }) {
  const router = useRouter();

  function handleLogout() {
    localStorage.removeItem('edusupply_token');
    router.push('/login');
  }

  const dashboardHref = role === 'vendor' ? '/vendor/dashboard' : '/dashboard';

  return (
    <nav className="bg-gradient-to-br from-brand-dark to-brand-light">
      <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
        <span className="font-heading font-medium text-lg text-white">
          EduSupply
        </span>
        <div className="flex items-center gap-6">
          <Link href={dashboardHref} className="text-sm text-white/90 hover:text-white transition-colors">
            Dashboard
          </Link>
          {role === 'school' && (
            <Link href="/orders" className="text-sm text-white/90 hover:text-white transition-colors">
              Orders
            </Link>
          )}
          {role === 'vendor' && (
            <Link href="/products" className="text-sm text-white/90 hover:text-white transition-colors">
              Products
            </Link>
          )}
          <button
            onClick={handleLogout}
            className="text-sm text-white/90 hover:text-white transition-colors"
          >
            Log out
          </button>
        </div>
      </div>
    </nav>
  );
}