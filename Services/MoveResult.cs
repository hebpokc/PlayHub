namespace PlayHub.Services;

/// <summary>Ответ на попытку хода.</summary>
public enum MoveResult
{
    Ok,
    NotAPlayer,
    GameNotStarted,
    GameFinished,
    NotYourTurn,
    CellTaken,
    BadIndex
}
