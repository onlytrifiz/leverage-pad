"use client";

import Image from "next/image";
import { motion } from "motion/react";

/**
 * The sad version of the mark for the 404: it drifts, slowly, so the page reads
 * as a place rather than a dead end.
 */
export default function NotFoundMark() {
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: [0, -6, 0] }}
      transition={{
        opacity: { duration: 0.5 },
        y: { duration: 5, repeat: Infinity, ease: "easeInOut" },
      }}
    >
      <Image
        src="/logo-transparent.png"
        alt=""
        width={56}
        height={56}
        className="opacity-40 grayscale"
      />
    </motion.div>
  );
}
