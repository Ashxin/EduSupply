'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { jwtDecode } from 'jwt-decode';

interface DecodedToken {
  id: string;
  role: 'school' | 'vendor';
  iat: number;
  exp: number;
}

export default function RequireAuth({
  role,
  children,
}: {
  role: 'school' | 'vendor';
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('edusupply_token');

    if (!token) {
      router.replace('/login');
      return;
    }

    try {
      const decoded = jwtDecode<DecodedToken>(token);
      if (decoded.role !== role) {
        router.replace('/login');
        return;
      }
      setChecked(true);
    } catch {
      router.replace('/login');
    }
  }, [role, router]);

  if (!checked) {
    return null;
  }

  return <>{children}</>;
}