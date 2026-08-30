package Box2D.Collision.Shapes
{
   public class b2ShapeDef
   {
      
      public var isSensor:Boolean = false;
      
      public var density:Number = 0;
      
      public var type:int = b2Shape.e_unknownShape;
      
      public var restitution:Number = 0;
      
      public var userData:* = null;
      
      public var filter:b2FilterData = new b2FilterData();
      
      public var friction:Number = 0.2;
      
      public function b2ShapeDef()
      {
         super();
      }
   }
}

