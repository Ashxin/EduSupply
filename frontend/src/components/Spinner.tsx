'use client';

import { motion } from 'framer-motion';

export default function Spinner({ size = 32 }: { size?: number }) {
  return (
    <motion.div
      animate={{ rotate: 360 }}
      transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
      style={{ width: size, height: size }}
      className="rounded-full border-3 border-brand-light border-t-brand-dark"
    />
  );
}