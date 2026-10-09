"""The pack's root folder, for the folders that sit beside the code (looks, camera_sets, local, ...)."""
import os

# rednode_studio/core/paths.py -> the pack root, two folders up
PACK_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
