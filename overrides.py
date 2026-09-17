"""Environment overrides, read in one place.

The pack takes a few settings from environment variables: where its caches and
presets live (the tests point those at temp folders), OLLAMA_HOST, and the Civitai
token. They are read here and nowhere else, so a reader of the pack sees every
variable it looks at in one file.
"""
import os

KNOWN = ("OLLAMA_HOST", "CIVITAI_API_TOKEN", "KREA2RN_SETTINGS_DIR", "KREA2RN_PROMPT_CACHE",
         "KREA2RN_LORA_CACHE", "KREA2RN_CAMERA_SETS", "KREA2RN_CONTROL_SCENES",
         "KREA2RN_GROUP_SCENES", "KREA2RN_GROUP_RULES", "KREA2RN_LORA_PRESETS",
         "KREA2RN_PALETTE_PRESETS", "KREA2RN_POST_PRESETS", "KREA2RN_PRESETS",
         "KREA2RN_SAVE_PRESETS", "KREA2RN_SAVE_INDEX", "KREA2RN_CAPTION_INSTRUCTIONS",
         "KREA2RN_VISION_PROMPTS", "KREA2RN_WORKSPACE_PRESETS", "RN_RESCUE_MAX_MB",
         "KREA2MB_LEGACY_PACKED_POSITIONS")


def env(name, default=""):
    """The variable's value, or `default` when it is not set."""
    value = os.environ.get(name)
    return default if value is None else value
