"""AtherNull independent verifier.

Runs on a fresh checkout of the produced commit/patch, executes documented
acceptance checks, and produces a structured evidence report. Must never
self-certify based solely on the worker's own success claim (spec §3, §8).
"""
