using Diagram.Core.Contracts;

namespace Diagram.Host.Core;

public readonly record struct Result<T>(T? Value, AppError? Error)
{
    public bool Ok => Error is null;
    public static Result<T> Success(T value) => new(value, null);
    public static Result<T> Fail(string code, string message, bool retryable = false, string? outcome = null) =>
        new(default, new AppError { Code = code, Message = message, Retryable = retryable, Outcome = outcome });
    public static Result<T> From(AppError error) => new(default, error);
    public T Unwrap() => Ok ? Value! : throw new HostException(Error!);
}

public sealed class HostException(AppError error) : Exception(error.Message)
{
    public AppError Error { get; } = error;
    public static HostException Of(string code, string message) => new(new AppError { Code = code, Message = message, Retryable = false });
}
