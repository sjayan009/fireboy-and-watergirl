package Box2D.Collision
{
   public class b2Proxy
   {
      
      public var overlapCount:uint;
      
      public var lowerBounds:Array = [uint(0),uint(0)];
      
      public var upperBounds:Array = [uint(0),uint(0)];
      
      public var userData:* = null;
      
      public var timeStamp:uint;
      
      public function b2Proxy()
      {
         super();
      }
      
      public function GetNext() : uint
      {
         return lowerBounds[0];
      }
      
      public function IsValid() : Boolean
      {
         return overlapCount != b2BroadPhase.b2_invalid;
      }
      
      public function SetNext(param1:uint) : void
      {
         lowerBounds[0] = param1 & 0xFFFF;
      }
   }
}

