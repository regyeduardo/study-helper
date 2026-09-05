from enum import Enum


class FileType(str, Enum):
    class_ = "class"
    explanation = "explanation"
    reading = "reading"
    meeting = "meeting"


class TempFileStatus(str, Enum):
    generating = "generating"
    complete = "complete"
    error = "error"


class RightAlternative(str, Enum):
    A = "A"
    B = "B"
    C = "C"
    D = "D"
    E = "E"


