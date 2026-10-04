"use client";

import { motion } from "motion/react";
import { EngravedArt } from "@/components/brand/EngravedArt";

/**
 * The sad version of the brand for the 404: the engraved bear, standing on a
 * page with nothing on it. It drifts, slowly, so the page reads as a place
 * rather than a dead end.
 */
export default function NotFoundMark() {
  return (
    <motion.div
      className="w-[min(78vw,340px)] text-ink/55"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: [0, -6, 0] }}
      transition={{
        opacity: { duration: 0.5 },
        y: { duration: 5, repeat: Infinity, ease: "easeInOut" },
      }}
    >
      <EngravedArt name="bear" />
    </motion.div>
  );
}
